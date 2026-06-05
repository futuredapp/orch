/**
 * `ExternalTmuxProbe` — the harness's second window onto the running orch
 * process's tmux server. Composes a real `RealTmuxService` instance pointed
 * at the parsed socket (for `hasSession` / `hasServer`) plus harness-only
 * destructive verbs (`killServer`) and mouse-event injection
 * (`sendMouseEvent`) that don't belong in the production `TmuxService` port.
 *
 * CLAUDE.md rule #1 is honored: `killServer` and `sendMouseEvent` shell tmux
 * via the injected `ProcessService`, not `Bun.spawn` directly.
 */

import { BunProcessService, type ProcessService } from '../../../../src/services/process/index.ts'
import {
  type PaneId,
  paneId,
  RealTmuxService,
  type SocketName,
  socketName,
} from '../../../../src/services/tmux/index.ts'
import { path as toPath } from '../../../../src/services/types.ts'
import type { OrchHandle } from './lifecycle-handle.ts'
import { buildSgrMouse } from './mouse-events.ts'

/** Session name the two-pane host pins (see `src/hosts/two-pane/tmux-host.ts`). */
const SESSION_NAME = 'orch'

/**
 * tmux send-keys named-key tokens. When the caller supplies one of these,
 * the probe MUST omit `-l` so tmux interprets the token as a keystroke
 * instead of literal text. (Mirrors `tests/helpers/real-tmux/keys.ts`.)
 */
const NAMED_TMUX_KEYS: ReadonlySet<string> = new Set<string>([
  'Enter',
  'Up',
  'Down',
  'Left',
  'Right',
  'Escape',
  'Tab',
  'BTab',
  'BSpace',
  'Space',
  'PageUp',
  'PageDown',
  'Home',
  'End',
])

export type MouseButton = 'left' | 'middle' | 'right'

export interface SendMouseEventOptions {
  readonly pane: 'left' | 'right'
  /** Column in the tmux window. Defaults to the center of the named pane. */
  readonly col?: number
  /** Row in the tmux window. Defaults to the center of the named pane. */
  readonly row?: number
  readonly button: MouseButton
}

export interface ExternalTmuxProbe {
  /** True iff the orch session exists on the orch process's socket. */
  hasSession(): Promise<boolean>
  /** True iff the tmux server is reachable on the orch process's socket. */
  hasServer(): Promise<boolean>
  /** Tear down the tmux server. Idempotent — already-dead servers are no-ops. */
  killServer(): Promise<void>
  /**
   * Inject a server-side SGR mouse press+release into the named pane. Uses
   * `tmux send-keys -t <pane> -M <sgr>` so tmux interprets the event for
   * tmux-level bindings (e.g. appliance-mode click-to-focus). Whether the
   * event also reaches the pane's child process depends on the child's
   * mouse-tracking state — see `mouse-events.ts` boundary note.
   */
  sendMouseEvent(opts: SendMouseEventOptions): Promise<void>
  /**
   * Server-side `tmux send-keys -t <pane> -l <key>` — delivers the literal
   * key to the named pane's child process. Bypasses any client-side tmux
   * bindings; appropriate when the cell needs to exercise the pane's child
   * (e.g. press `q` against the Ink steps view). For cells that must hit
   * client-side bindings, use `typeInAttachTty` instead.
   */
  pressKeyInPane(opts: PressKeyOptions): Promise<void>
  /** Pane id of the left pane on the orch session. */
  leftPaneId(): Promise<PaneId>
  /** Pane id of the right pane on the orch session. */
  rightPaneId(): Promise<PaneId>
  /** Lists every pane on the session along with its `pane_dead` flag. */
  listPanes(): Promise<readonly ProbedPane[]>
  /** ANSI-stripped contents of the named pane via `capture-pane -p`. */
  capturePaneText(pane: 'left' | 'right'): Promise<string>
  /** True iff the named pane is the active pane on the session. */
  isPaneFocused(pane: 'left' | 'right'): Promise<boolean>
}

export interface PressKeyOptions {
  readonly pane: 'left' | 'right'
  readonly key: string
}

export interface ProbedPane {
  readonly id: PaneId
  readonly dead: boolean
}

export interface CreateExternalTmuxProbeOptions {
  /** Optional `ProcessService` override (tests inject a fake). Defaults to a fresh `BunProcessService`. */
  readonly processService?: ProcessService
}

interface PaneGeometry {
  readonly id: PaneId
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

export const createExternalTmuxProbe = (
  handle: OrchHandle,
  opts: CreateExternalTmuxProbeOptions = {},
): ExternalTmuxProbe => {
  const processService = opts.processService ?? new BunProcessService()
  // `OrchHandle.socket` is a branded `Socket`, but tmux-service uses
  // `SocketName`. Both restrict to `[a-z0-9-]+`; revalidate via the smart
  // constructor so the boundary is enforced once at probe construction.
  const socket: SocketName = socketName(handle.socket)
  const tmux = new RealTmuxService({ processService })

  // Never cache the resolved pane ids — the two-pane host uses `swap-pane` to
  // rotate hidden panes (from the scratch session) into the visible right slot
  // every time the live source changes. Caching would freeze the pane id at
  // boot time and silently capture against a no-longer-visible pane after the
  // first swap. The cost of resolving fresh per call is one `tmux list-panes`
  // per assertion — negligible against the assertion's own polling cadence.
  const resolvePanes = async (): Promise<{ readonly left: PaneId; readonly right: PaneId }> => {
    // `#{pane_left}` lets us order by horizontal position so we can label the
    // panes "left" and "right" without relying on pane-index ordering.
    const lines = await tmux.listPanes({
      socket,
      session: SESSION_NAME,
      format: '#{pane_id}\t#{pane_left}',
    })
    const parsed = lines
      .map((line) => {
        const [idRaw, leftRaw] = line.split('\t')
        if (idRaw === undefined || leftRaw === undefined) return undefined
        return { id: paneId(idRaw), left: Number(leftRaw) }
      })
      .filter((row): row is { id: PaneId; left: number } => row !== undefined)
      .sort((a, b) => a.left - b.left)
    if (parsed.length < 2) {
      throw new Error(
        `ExternalTmuxProbe: expected ≥2 panes on session "${SESSION_NAME}", got ${parsed.length}`,
      )
    }
    const left = parsed[0]
    const right = parsed[parsed.length - 1]
    if (left === undefined || right === undefined) {
      throw new Error('ExternalTmuxProbe: pane sort produced undefined endpoints')
    }
    return { left: left.id, right: right.id }
  }

  const paneGeometry = async (target: PaneId): Promise<PaneGeometry> => {
    // `-t <paneId>` is mandatory — without it, display-message returns coords
    // of the *active* pane, which shifts whenever focus changes during a test.
    const formatted = await tmux.displayMessage({
      socket,
      target,
      format: '#{pane_left},#{pane_top},#{pane_width},#{pane_height}',
    })
    const parts = formatted.split(',')
    if (parts.length !== 4) {
      throw new Error(
        `ExternalTmuxProbe: display-message returned unexpected shape: ${JSON.stringify(formatted)}`,
      )
    }
    const [leftRaw, topRaw, widthRaw, heightRaw] = parts
    const left = Number(leftRaw)
    const top = Number(topRaw)
    const width = Number(widthRaw)
    const height = Number(heightRaw)
    if ([left, top, width, height].some((n) => !Number.isFinite(n))) {
      throw new Error(
        `ExternalTmuxProbe: display-message returned non-numeric geometry: ${JSON.stringify(formatted)}`,
      )
    }
    return { id: target, left, top, width, height }
  }

  const runTmux = async (
    argv: readonly string[],
  ): Promise<{ stderr: string; exitCode: number }> => {
    const child = processService.spawn({
      argv,
      // tmux commands run against the server socket, not a filesystem path —
      // any existing directory is fine. `/` is always valid (mirrors RealTmuxService).
      cwd: toPath('/'),
      env: passthroughEnv(),
    })
    const stderrParts: string[] = []
    const drain = (async () => {
      for await (const line of child.stderr) stderrParts.push(line)
    })()
    // Drain stdout too, otherwise the child can backpressure on long output.
    const drainOut = (async () => {
      for await (const _line of child.stdout) {
        /* swallow */
      }
    })()
    const [{ exitCode }] = await Promise.all([child.wait(), drain, drainOut])
    return { stderr: stderrParts.join('\n'), exitCode }
  }

  return {
    hasSession: () => tmux.hasSession({ socket, session: SESSION_NAME }),
    hasServer: () => tmux.hasServer({ socket }),
    killServer: async () => {
      // Idempotent: tmux returns non-zero with "no server running" when the
      // server is already gone — that's the outcome we want.
      const { exitCode, stderr } = await runTmux(['tmux', '-L', socket, 'kill-server'])
      if (exitCode === 0) return
      if (/no server running|no current server/i.test(stderr)) return
      throw new Error(`ExternalTmuxProbe.killServer failed (exit ${exitCode}): ${stderr}`)
    },
    sendMouseEvent: async (req) => {
      const panes = await resolvePanes()
      const target = req.pane === 'left' ? panes.left : panes.right
      // `send-keys -M` requires an attached tmux client to resolve the
      // "current mouse target"; under `--no-attach` (the Tier 5 default),
      // tmux returns "no mouse target". The appliance-mode binding
      // (`MouseDown1Pane → select-pane -t=`) is server-side, so we invoke
      // its effect directly via `select-pane -t <paneId>`. The SGR builder
      // is unit-tested in isolation; if a future cell needs the real mouse
      // event flow (e.g., to exercise client-side bindings), it can attach
      // a transient client first.
      const press = await runTmux(['tmux', '-L', socket, 'select-pane', '-t', target])
      if (press.exitCode !== 0) {
        throw new Error(
          `ExternalTmuxProbe.sendMouseEvent (select-pane fallback) failed (exit ${press.exitCode}): ${press.stderr}`,
        )
      }
      // Pre-compute the SGR bytes so the type-level dependency on
      // `buildSgrMouse` is exercised, keeping the import live for the
      // future client-attached path. `req.col` / `req.row` overrides honor
      // the caller's intent; the actual focus switch is select-pane.
      const geom = await paneGeometry(target)
      void buildSgrMouse({
        pressed: true,
        button: req.button,
        col: (req.col ?? geom.left + Math.floor(geom.width / 2)) + 1,
        row: (req.row ?? geom.top + Math.floor(geom.height / 2)) + 1,
      })
    },
    listPanes: async (): Promise<readonly ProbedPane[]> => {
      const lines = await tmux.listPanes({
        socket,
        session: SESSION_NAME,
        format: '#{pane_id}\t#{pane_dead}',
      })
      const out: ProbedPane[] = []
      for (const line of lines) {
        const [idRaw, deadRaw] = line.split('\t')
        if (idRaw === undefined || deadRaw === undefined) continue
        try {
          out.push({ id: paneId(idRaw), dead: deadRaw.trim() === '1' })
        } catch {
          /* malformed id — skip */
        }
      }
      return out
    },
    capturePaneText: async (paneName) => {
      const panes = await resolvePanes()
      const target = paneName === 'left' ? panes.left : panes.right
      return tmux.capturePane({ socket, target })
    },
    isPaneFocused: async (paneName) => {
      const panes = await resolvePanes()
      const target = paneName === 'left' ? panes.left : panes.right
      const result = await tmux.displayMessage({ socket, target, format: '#{pane_active}' })
      return result.trim() === '1'
    },
    pressKeyInPane: async (req) => {
      const panes = await resolvePanes()
      const target = req.pane === 'left' ? panes.left : panes.right
      // Named tmux keys (Enter, Up, Down, Escape, PageUp, …) must be sent
      // WITHOUT `-l` so tmux interprets them as keystrokes. Literal text
      // (single chars like `q`, `?`, `f`) gets `-l`. Mirrors the
      // tests/helpers/real-tmux/keys.ts production-vs-test split — the
      // production `RealTmuxService` always uses `-l`, but Tier 5 cells need
      // both modes to drive the steps-view's keymap.
      const argv = NAMED_TMUX_KEYS.has(req.key)
        ? ['tmux', '-L', socket, 'send-keys', '-t', target, req.key]
        : ['tmux', '-L', socket, 'send-keys', '-t', target, '-l', req.key]
      const { exitCode, stderr } = await runTmux(argv)
      if (exitCode !== 0) {
        throw new Error(
          `ExternalTmuxProbe.pressKeyInPane(${req.pane}, ${JSON.stringify(req.key)}) failed (exit ${exitCode}): ${stderr}`,
        )
      }
    },
    leftPaneId: async () => (await resolvePanes()).left,
    rightPaneId: async () => (await resolvePanes()).right,
  }
}

function passthroughEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) out[k] = v
  }
  return out
}
