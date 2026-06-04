/**
 * session.ts — DEV-ONLY. Resolve a running orch two-pane session from the
 * outside and drive its tmux surface (capture panes, send keys, focus, tear
 * down). This is the "real tmux channel" half of the QA toolkit — it simulates
 * a *human* at the terminal. The deterministic step-advancing channel lives in
 * `drive.ts`.
 *
 * Honors CLAUDE.md rule #1: every tmux call goes through the sanctioned
 * `RealTmuxService` / `BunProcessService`, never `Bun.spawn` directly. The
 * named-key send and `kill-server` paths shell tmux via the injected
 * `ProcessService` (the production `TmuxService` port intentionally omits
 * them), mirroring `tests/helpers/behavioral-dsl/internal/external-tmux-probe.ts`.
 */

import { readdir } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { BunProcessService, type ProcessService } from '../../src/services/process/index.ts'
import {
  type PaneId,
  paneId,
  RealTmuxService,
  type SocketName,
  socketName,
} from '../../src/services/tmux/index.ts'
import { path as toPath } from '../../src/services/types.ts'
import { RUN_ID_PATTERN } from '../../src/state/index.ts'

/** Session name the two-pane host pins (see `src/hosts/two-pane/tmux-host.ts`). */
const SESSION = 'orch'

/** Logical pane name a caller addresses. */
export type PaneName = 'left' | 'right'

/**
 * tmux named-key tokens. Sent WITHOUT `-l` so tmux interprets them as
 * keystrokes; any other string is sent literally with `-l`. Mirrors
 * `tests/helpers/real-tmux/keys.ts`.
 */
const NAMED_KEYS: ReadonlySet<string> = new Set<string>([
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

export interface ResolvedRun {
  readonly runId: string
  readonly runDir: string
  readonly socket: SocketName
}

/**
 * Resolve the run to drive: an explicit `runId`, else the newest run under
 * `<cwd>/.orch/state` (RunIds sort chronologically).
 */
export async function resolveRun(opts: {
  readonly cwd: string
  readonly runId?: string
}): Promise<ResolvedRun> {
  // Absolute so downstream tools (e.g. `freeze`, run with cwd `/`) resolve the
  // control/screenshot paths correctly regardless of their own working dir.
  const stateBase = nodePath.resolve(opts.cwd, '.orch', 'state')
  let runId = opts.runId
  if (runId === undefined) {
    const entries = await readdir(stateBase).catch(() => [] as string[])
    const runs = entries.filter((e) => RUN_ID_PATTERN.test(e)).sort()
    const newest = runs.at(-1)
    if (newest === undefined) {
      throw new Error(`qa: no runs under ${stateBase} — launch a workflow first`)
    }
    runId = newest
  }
  return {
    runId,
    runDir: nodePath.join(stateBase, runId),
    socket: socketName(`orch-${runId}`),
  }
}

export interface ProbedPane {
  readonly id: PaneId
  readonly dead: boolean
}

export interface QaSession {
  readonly socket: SocketName
  /** True iff the tmux server for this run is reachable. */
  hasServer(): Promise<boolean>
  /** Left/right pane ids, ordered by horizontal position (resolved fresh). */
  resolvePanes(): Promise<{ readonly left: PaneId; readonly right: PaneId }>
  /** Every pane with its `pane_dead` flag. */
  listPanes(): Promise<readonly ProbedPane[]>
  /** ANSI-stripped pane text (`capture-pane -p`); `raw` keeps escape codes. */
  capture(pane: PaneName, opts?: { readonly raw?: boolean }): Promise<string>
  /** True iff the named pane is the active pane. */
  isFocused(pane: PaneName): Promise<boolean>
  /** Make the named pane active (simulate clicking it). */
  focus(pane: PaneName): Promise<void>
  /** Send one key/text token to a pane (named key → keystroke, else literal). */
  sendKey(pane: PaneName, key: string): Promise<void>
  /** Tear down the tmux server (idempotent). */
  killServer(): Promise<void>
}

/** Build a session driver bound to one resolved run. */
export function createQaSession(
  run: ResolvedRun,
  deps: { readonly processService?: ProcessService } = {},
): QaSession {
  const processService = deps.processService ?? new BunProcessService()
  const tmux = new RealTmuxService({ processService })
  const socket = run.socket

  const resolvePanes = async (): Promise<{ readonly left: PaneId; readonly right: PaneId }> => {
    // Order by `#{pane_left}` so "left"/"right" track screen position, not pane
    // index — the two-pane host swap-pane's hidden panes into the right slot.
    const lines = await tmux.listPanes({ socket, session: SESSION, format: '#{pane_id}\t#{pane_left}' })
    const parsed = lines
      .map((line) => {
        const [idRaw, leftRaw] = line.split('\t')
        if (idRaw === undefined || leftRaw === undefined) return undefined
        return { id: paneId(idRaw), left: Number(leftRaw) }
      })
      .filter((row): row is { id: PaneId; left: number } => row !== undefined)
      .sort((a, b) => a.left - b.left)
    const left = parsed[0]
    const right = parsed[parsed.length - 1]
    if (left === undefined || right === undefined) {
      throw new Error(`qa: expected ≥2 panes on session "${SESSION}", got ${parsed.length}`)
    }
    return { left: left.id, right: right.id }
  }

  const targetFor = async (pane: PaneName): Promise<PaneId> => {
    const panes = await resolvePanes()
    return pane === 'left' ? panes.left : panes.right
  }

  const runTmux = async (argv: readonly string[]): Promise<{ stderr: string; exitCode: number }> => {
    const child = processService.spawn({ argv, cwd: toPath('/'), env: passthroughEnv() })
    const stderrParts: string[] = []
    const drainErr = (async () => {
      for await (const line of child.stderr) stderrParts.push(line)
    })()
    const drainOut = (async () => {
      for await (const _line of child.stdout) {
        /* swallow */
      }
    })()
    const [{ exitCode }] = await Promise.all([child.wait(), drainErr, drainOut])
    return { stderr: stderrParts.join('\n'), exitCode }
  }

  return {
    socket,
    hasServer: () => tmux.hasServer({ socket }),
    resolvePanes,
    listPanes: async () => {
      const lines = await tmux.listPanes({ socket, session: SESSION, format: '#{pane_id}\t#{pane_dead}' })
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
    capture: async (pane, opts = {}) => {
      const target = await targetFor(pane)
      return tmux.capturePane({ socket, target, escapeCodes: opts.raw === true })
    },
    isFocused: async (pane) => {
      const target = await targetFor(pane)
      const result = await tmux.displayMessage({ socket, target, format: '#{pane_active}' })
      return result.trim() === '1'
    },
    focus: async (pane) => {
      const target = await targetFor(pane)
      await tmux.selectPane({ socket, target })
    },
    sendKey: async (pane, key) => {
      const target = await targetFor(pane)
      if (NAMED_KEYS.has(key)) {
        const { exitCode, stderr } = await runTmux(['tmux', '-L', socket, 'send-keys', '-t', target, key])
        if (exitCode !== 0) throw new Error(`qa: send-keys ${key} failed (exit ${exitCode}): ${stderr}`)
        return
      }
      await tmux.sendKeys({ socket, target, keys: [key] })
    },
    killServer: async () => {
      const { exitCode, stderr } = await runTmux(['tmux', '-L', socket, 'kill-server'])
      if (exitCode === 0) return
      if (/no server running|no current server/i.test(stderr)) return
      throw new Error(`qa: kill-server failed (exit ${exitCode}): ${stderr}`)
    },
  }
}

function passthroughEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) out[k] = v
  }
  return out
}
