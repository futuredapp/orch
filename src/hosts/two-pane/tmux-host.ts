// ---------------------------------------------------------------------------
// TmuxHost — the `--mode=two-pane` implementation of the Host port.
// ---------------------------------------------------------------------------
//
// Two panes: left runs a `cat` placeholder with the status rollup drawn into
// it; right is a *swap target* for the pane-map controller (post-2026-05-11
// unified-pane-map plan). Hidden source panes — runner PTYs, `tail -F` over
// per-step tees, the parallel-block rollup tail — live in per-source tmux
// sessions (`orch-src-<sanitized-key>`) created lazily by the controller on
// the same socket as `orch`, and are `tmux swap-pane`d into the visible right
// slot on demand. Pane ids are server-wide, so swap-pane works cross-session.
// The visible right pane never directly hosts a runner process; bytes always
// arrive via swap. The left pane is unchanged (still owns the steps-view
// daemon).
//
// Every pane write goes through the shared PaneQueue — transcript fan-out,
// status rollup, and respawn-pane -k all serialize per pane so a pending
// transcript keystroke can never land on an interactive process that just
// took the pane over.
//
// **File size.** This file exceeds the project's 300-LOC warning cap.
// The host is the natural integration seam between three subsystems
// (runners, lifecycle, pane-map) and splitting it for size alone would
// obscure that integration. Revisit if/when this file exceeds 700 LOC
// after the parallel-switcher pass.

import type { RunMode } from '../../core/run-mode.ts'
import type { RunId, StepName } from '../../core/types.ts'
import type { StepLifecycleEvent } from '../../core/workflow.ts'
import { type JsonObject, orchLog, type SessionLogger } from '../../observability/index.ts'
import type { RunnerEvent, TranscriptLine } from '../../runners/index.ts'
import type { Clock } from '../../services/clock/index.ts'
import type { FsService } from '../../services/fs/index.ts'
import { BunFsService } from '../../services/fs/index.ts'
import type { ProcessService } from '../../services/process/index.ts'
import type { PaneId, SocketName, TmuxService } from '../../services/tmux/index.ts'
import {
  initOrchSession,
  paneId,
  RealTmuxService,
  socketName,
  TmuxCommandError,
} from '../../services/tmux/index.ts'
import type { Path } from '../../services/types.ts'
import { path as toPath } from '../../services/types.ts'
import type { StateStore } from '../../state/index.ts'
import type {
  CommandLine,
  ForegroundShutdownReason,
  Host,
  InteractiveResult,
  InteractiveSpawn,
  PaneAttachment,
  PaneRole,
} from '../host.ts'
import { HostUnavailableError } from '../host.ts'
import { createPerStepTee, type PerStepTee } from '../plain/per-step-tee.ts'
import { renderTranscriptLine } from '../plain/render-line.ts'
import { assertNoNestedTmux, createAttachForeground } from './attach-foreground.ts'
import { createLifecycleChoreographer } from './lifecycle-choreographer.ts'
import {
  createRightPaneController,
  type RightPaneController,
  type SourceKey,
} from './pane-map/index.ts'
import { createPaneQueue, type PaneQueue } from './pane-queue.ts'
import { startPipePaneCapture } from './pipe-pane-capture.ts'
import { installStdioCapture, type StdioCapture } from './stdio-capture.ts'
import { type StartStepsViewHandle, type StepsIntent, startStepsView } from './steps-view/index.ts'
import { restoreTerminalModes } from './terminal-reset.ts'

// Defaults mirror the old `src/cli/tmux-wiring.ts`. Kept in-file because they
// are pane-geometry choices, not user-facing config; a v2 layout-tree surface
// would replace them.
const SESSION = 'orch'
const WIDTH = 200
const HEIGHT = 50
const RIGHT_PERCENT = 70
const PLACEHOLDER_CMD = 'cat'
// Global pane-died hook that `initOrchSession` wires — fires once per pane
// death and signals a per-pane `wait-for` channel so interactive runs can
// detect their child's exit deterministically.
//
// Two non-obvious tmux quirks force the shape below:
//   1. tmux commands invoked from a hook do NOT format-expand `#{hook_pane}`.
//      Only `run-shell` performs that substitution, so we have to bounce
//      through it to get the dying pane's id into the channel name.
//   2. The shell `tmux …` invoked by `run-shell` is a fresh client. Without
//      `-L <socket>` it would connect to the default socket and signal the
//      WRONG server — our scoped `wait-for` would hang until the user
//      force-killed the terminal. The interpolated socket below is the fix
//      for that "stuck cancel" bug.
const buildPaneDiedCommand = (socket: SocketName): string =>
  `run-shell "tmux -L ${socket} wait-for -S pane-exit-#{hook_pane}"`

// Auto-stop: how long to wait for a clean EOF-driven pane exit before falling
// through to the existing kill-session teardown. Generous because Codex's
// interactive REPL is slow to flush/exit (see the codex-capture handover).
const AUTO_STOP_CLEAN_EXIT_MS = 5000

/**
 * Race the pane's `pane-exit` death against the auto-stop signal channel the
 * agent's hook fires on turn completion. Returns which branch won. The losing
 * waiter is left parked (its `tmux wait-for` client); callers release it during
 * teardown (kill-session resolves pane-exit; an explicit `signalChannel`
 * releases the stop channel). Both `.catch` guards keep a late settle from
 * surfacing as an unhandled rejection after the race resolves.
 */
function racePaneExitVsStop(
  tmux: TmuxService,
  socket: SocketName,
  paneExitChannel: string,
  stopChannel: string,
): Promise<'pane-exit' | 'stop'> {
  const paneExit = tmux
    .waitFor({ socket, channel: paneExitChannel })
    .then((): 'pane-exit' => 'pane-exit')
  const stop = tmux.waitFor({ socket, channel: stopChannel }).then((): 'stop' => 'stop')
  paneExit.catch(() => {})
  stop.catch(() => {})
  return Promise.race([paneExit, stop])
}

/**
 * Attempt a clean exit on the stop signal: send EOF (Ctrl-D) to the idle REPL
 * and bounded-wait the pane's death. `remain-on-exit on` makes a clean agent
 * exit fire `pane-died`, resolving `pane-exit`. If the bounded wait elapses,
 * return `'forced'` so the caller falls through to the existing kill-session
 * teardown — no new kill mechanism is invented.
 */
async function terminateOnAutoStop(
  tmux: TmuxService,
  socket: SocketName,
  target: PaneId,
  paneExitChannel: string,
): Promise<'clean' | 'forced'> {
  await tmux.sendKeys({ socket, target, keys: ['\u0004'] }).catch(() => {})
  try {
    await tmux.waitFor({ socket, channel: paneExitChannel, timeoutMs: AUTO_STOP_CLEAN_EXIT_MS })
    return 'clean'
  } catch {
    return 'forced'
  }
}

// Backstop poll cadence for the interactive completion wait. The primary
// signal is the `pane-died` hook channel, which is unbounded ON PURPOSE — a
// human may pause the agent for arbitrarily long, so orch MUST NOT impose a
// hard timeout on an interactive wait (see WaitForOptions.timeoutMs docs).
//
// But the hook is a four-hop indirect signal (process exits → remain-on-exit
// holds the pane → global `pane-died` hook → `run-shell` does
// `wait-for -S pane-exit-<id>`). Under host contention the final signal can be
// lost or arrive long after the pane is already dead, leaving the wait parked
// until the *caller's* timeout fires with no diagnosis — the
// two-pane-sequential-runs flake (2026-05-26), where it surfaced as a generic
// 5s Bun test timeout. This poll closes the gap by observing pane death
// directly via `#{pane_dead}`. It NEVER fails a live pane: a still-running
// pane just keeps the wait parked, preserving the human-pause contract. A slow
// cadence keeps the cost negligible (one `display-message` per second) even
// across a multi-minute human pause.
const PANE_LIVENESS_POLL_MS = 1000

interface PaneExitOutcome {
  /** Which signal observed the exit first. */
  readonly via: 'hook' | 'liveness-poll'
  /** `#{pane_dead_status}` (the pane's exit code) when the poll read it. */
  readonly deadStatus?: string
}

/**
 * Non-throwing probe of the interactive pane's liveness. Returns the dead
 * status when tmux reports the pane dead, `'alive'` when it is still running,
 * and `'gone'` when the pane (or its server) has vanished — all three are data
 * so the poll loop never treats a probe as an error. `display-message` throws
 * on empty output (pane gone) or a dead socket; both mean "no longer running".
 */
async function probePaneExit(
  tmux: TmuxService,
  socket: SocketName,
  paneId: PaneId,
): Promise<{ readonly dead: true; readonly status: string } | 'alive' | 'gone'> {
  try {
    const out = await tmux.displayMessage({
      socket,
      target: paneId,
      format: '#{pane_dead},#{pane_dead_status}',
    })
    const [deadFlag, status = ''] = out.trim().split(',')
    return deadFlag === '1' ? { dead: true, status } : 'alive'
  } catch {
    return 'gone'
  }
}

/**
 * Wait for the interactive pane to exit. Races the unbounded `pane-died` hook
 * channel against a slow liveness poll. The hook is the fast path; the poll is
 * a backstop for a lost/delayed hook signal under contention. The poll never
 * fails a live pane, so a human pause keeps the wait parked indefinitely —
 * identical observable behaviour to the bare `waitFor` it replaces, minus the
 * silent hang. When the poll wins, the parked hook `wait-for` client is
 * released via `signalChannel` so it cannot linger as an orphan tmux process.
 *
 * Exported for unit testing against `FakeTmuxService` + `FakeClock`.
 */
export async function awaitInteractivePaneExit(
  tmux: TmuxService,
  socket: SocketName,
  paneId: PaneId,
  channel: string,
  clock: Clock,
  pollMs: number = PANE_LIVENESS_POLL_MS,
): Promise<PaneExitOutcome> {
  let settled = false

  const hook = tmux.waitFor({ socket, channel }).then((): PaneExitOutcome => ({ via: 'hook' }))
  hook.catch(() => {})

  const poll = (async (): Promise<PaneExitOutcome> => {
    for (;;) {
      await clock.sleep(pollMs)
      // Hook already won the race — abandon quietly (caught below) instead of
      // issuing one more probe.
      if (settled) throw new Error('pane-exit wait superseded by hook')
      const probe = await probePaneExit(tmux, socket, paneId)
      if (probe === 'alive') continue
      return { via: 'liveness-poll', deadStatus: probe === 'gone' ? undefined : probe.status }
    }
  })()
  poll.catch(() => {})

  const outcome = await Promise.race([hook, poll])
  settled = true
  if (outcome.via === 'liveness-poll') {
    await tmux.signalChannel({ socket, channel }).catch(() => {})
  }
  return outcome
}

// tmux's `(No such file or directory)` / `no server running` / `session not
// found` / `can't find session` stderr patterns all share one meaning: the
// tmux session (or the whole server) the host was talking to is gone, and
// any subsequent pane-allocating command will fail the same way. The user's
// real-world repro hit this after detaching: the attach client exited, the
// run kept going in the background, the next interactive step issued
// `tmux split-window` against a deleted socket, and the unwrapped
// `TmuxCommandError` crashed Bun with a stack trace. Recognising the pattern
// lets the host translate it into a typed `HostUnavailableError` the CLI
// can render as a clean failure summary.
// Belt-and-suspenders: tmux/macOS variants surface this state with a few
// distinct stderr shapes. The current observed set (incident
// r-2026-05-22-093650-j0):
//   - "error connecting to /private/tmp/tmux-501/<sock> (No such file or directory)"
//   - "no server running on /tmp/tmux-501/<sock>"
//   - "session not found: <name>" / "can't find session <name>"
//   - "lost server"
// Each alternation is independently sufficient; "no such file or directory"
// alone catches the macOS connect-time variant we hit in the wild, but the
// explicit alternations protect against upstream tmux changing the prefix.
export const TMUX_SESSION_LOST_PATTERN =
  /no server running|session not found|can't find session|no such file or directory|error connecting to|lost server/i

/**
 * True when a `TmuxCommandError`'s stderr matches the canonical
 * "tmux server is gone" shapes observed in the wild. Used by the host to
 * translate dead-socket failures into `HostUnavailableError`. Exported so
 * adapter-level tests can pin classification against new wild-string
 * variants without going through the full host construction.
 */
export const isSessionLostError = (err: unknown): err is TmuxCommandError =>
  err instanceof TmuxCommandError && TMUX_SESSION_LOST_PATTERN.test(err.stderr)

const errorLifecycleFields = (err: unknown): JsonObject => {
  const base: Record<string, unknown> = {
    error: String(err),
  }
  if (err instanceof Error) {
    base.errorName = err.name
    base.errorMessage = err.message
  }
  if (err instanceof TmuxCommandError) {
    base.tmuxExitCode = err.exitCode
    base.tmuxStderr = err.stderr
  }
  return base
}

export interface TmuxHostOptions {
  readonly tmux?: TmuxService
  readonly processService: ProcessService
  readonly clock: Clock
  readonly runId: RunId
  readonly workflowName: string
  readonly stderr: NodeJS.WritableStream
  /** Skip the `tmux -V` probe. Tests using FakeTmuxService set this `true`. */
  readonly skipVersionCheck?: boolean
  /**
   * When true, `attachForeground()` prints the old "attach with …" hint and
   * resolves immediately — no tmux client is spawned. CLI sets this for
   * `--no-attach`, CI harnesses, and headless runs.
   */
  readonly skipAttach?: boolean
  /**
   * Environment map consulted for nested-tmux detection (`$TMUX`). Defaults
   * to `process.env` when the CLI creates the host; tests pass `{}` to
   * bypass the guard or `{ TMUX: '...' }` to exercise it.
   */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Current working directory for foreground spawns. Defaults to `process.cwd()`. */
  readonly cwd?: string
  /**
   * Stream used by `teardown()` to emit DEC private-mode reset sequences
   * (disable mouse tracking, exit alt-screen, …) after tmux hands the TTY
   * back. Defaults to `process.stdout`. Tests inject a non-TTY stream.
   */
  readonly stdout?: NodeJS.WritableStream
  /**
   * Optional session logger. Emits `host-created`, `tmux-session-created`,
   * `pane-created(L|R)`, `attach-foreground-started/exited`, `pane-died`, and
   * `host-torndown` to `lifecycle.ndjson` for post-mortem reconstruction.
   */
  readonly logger?: SessionLogger
  /**
   * FsService used by `--debug` pipe-pane capture to `mkdir -p` the
   * `logs/tmux/` directory. Optional because non-debug runs never create it.
   */
  readonly fs?: FsService
  /**
   * Hook used to register a hard-exit backstop that emits the DEC private-
   * mode resets (mouse tracking, alt-screen, bracketed paste). Defaults to
   * `process.on('exit', handler)`. Tests inject their own to capture the
   * registered handler without touching the global process.
   *
   * Lives on the two-pane host (not on the CLI entry point) because tmux is
   * the only host that sets those modes. Plain mode and pre-host error paths
   * must not register this backstop — Apple Terminal/iTerm2 treat
   * `\x1b[?1049l` as a screen-buffer toggle, which wipes the visible
   * terminal when the alt-screen was never entered.
   */
  readonly installExitHandler?: (handler: () => void) => void
  /**
   * Hook used to register a global unhandled-rejection backstop. Defaults to
   * `process.on('unhandledRejection', ...)`. Tests inject their own to capture
   * the registered handler without touching the global process.
   *
   * Lives on the two-pane host because it is the only host that shares its
   * stdout/stderr TTY with an attached `tmux` client. Node's default handler
   * prints the rejection stack to fd-2, which in that mode bleeds over the live
   * TUI grid (incident r-2026-05-25-171216-nu). The backstop routes the
   * rejection to the session lifecycle log instead and never touches fd-2.
   */
  readonly installRejectionHandler?: (handler: (reason: unknown) => void) => void
  /**
   * `<cwd>/.orch/state` — the run-state base directory. The steps-view daemon
   * uses this to compute `<basePath>/<runId>/` for tailing `state.json` and
   * `tui-intents.ndjson`. Required when the steps view is enabled; ignored
   * otherwise.
   */
  readonly basePath?: Path
  /**
   * Skip starting the steps-view daemon. Tests using `FakeTmuxService` set
   * this `true` because `runInteractive({ pane: 'left' })` would dispatch
   * recorded calls that the existing harness does not expect. Default
   * `false` — production runs always start the steps view.
   */
  readonly disableStepsView?: boolean
  /**
   * Optional handler for the steps-view's parsed user intents (Enter on a
   * step, follow-live, quit). When unset and a `stateStore` is supplied,
   * tmux-host wires the built-in `right-pane-controller` here. Setting this
   * explicitly bypasses the controller — useful for tests that want to
   * record intents directly.
   */
  readonly onStepsIntent?: (intent: StepsIntent) => void
  /**
   * State store for the right-pane-controller's per-kind dispatch (Phase 2
   * Enter behavior). When unset, the steps view still renders but Enter is a
   * no-op. The CLI always sets this; tests can omit to disable replay.
   */
  readonly stateStore?: StateStore
  /**
   * Live runner registry held by reference. The right-pane controller calls
   * `resumeRegistry.getRunnerForStep(step.name)` on every Enter press and
   * spawns the runner's `resumeCommand(...)` in window 1. The CLI creates
   * one instance and shares it with the workflow executor (which populates
   * it during `runStepOnce`); tests omit it to exercise the refusal path.
   */
  readonly resumeRegistry?: import('../../core/resume-registry.ts').ResumeRegistry
  /**
   * Renderer used by the right-pane-controller to format autonomous-agent
   * transcripts on Enter-to-inspect. The CLI defaults this to Claude's
   * `toClaudeTranscriptLines` (Phase A pragma — same posture as
   * `cli/commands/logs.ts`). Without it, replay falls back to a JSON
   * stringify which is unreadable. Phase E will swap the default for a
   * runner-registry dispatch keyed off `state.json`.
   */
  readonly transcriptRenderer?: import('../../runners/types.ts').Runner['toTranscriptLines']
}

export async function createTmuxHost(opts: TmuxHostOptions): Promise<Host> {
  // Nested-tmux guard fires before any session work. `attach-session` from
  // inside another tmux client silently routes to the outer server and
  // produces a confusing cascade; fail fast with actionable escape options.
  const env = opts.env ?? (process.env as Readonly<Record<string, string | undefined>>)
  assertNoNestedTmux(env, opts.skipAttach === true)

  void opts.logger?.append('lifecycle', { type: 'host-created', mode: 'two-pane' }).catch(() => {})

  const tmux: TmuxService =
    opts.tmux ?? new RealTmuxService({ processService: opts.processService })
  // `initOrchSession` writes the strict-sandbox tmux config via FsService
  // (see plan AD-3 — `history-limit 0` must be set BEFORE `new-session`).
  // CLI runs always supply `opts.fs` (`createDeps().fsService`); tests using
  // FakeTmuxService that omit it fall back to a real BunFsService that writes
  // a tiny temp file — harmless because the recorded createSession call is
  // fake-side and never actually reads the path.
  const fs: FsService = opts.fs ?? new BunFsService()
  const socket = socketName(`orch-${opts.runId}`)
  const queue = createPaneQueue()

  await initOrchSession(tmux, fs, {
    socket,
    session: SESSION,
    width: WIDTH,
    height: HEIGHT,
    paneDiedCommand: buildPaneDiedCommand(socket),
  })
  void opts.logger
    ?.append('lifecycle', {
      type: 'tmux-session-created',
      socket,
      session: SESSION,
      width: WIDTH,
      height: HEIGHT,
    })
    .catch(() => {})

  // Left pane is the session's initial pane. Swap the default shell for `cat`
  // so the status loop's sendKeys draws to a clean pty (no PS1 pollution).
  const initialPanes = await tmux.listPanes({
    socket,
    session: SESSION,
    format: '#{pane_id}',
  })
  const firstPane = initialPanes[0]
  if (firstPane === undefined) {
    throw new Error('TmuxHost: tmux new-session produced no panes')
  }
  const leftPaneId = paneId(firstPane)
  void opts.logger
    ?.append('lifecycle', { type: 'pane-created', pane: 'L', paneId: leftPaneId })
    .catch(() => {})

  // `clear && exec cat` — wipe any prior output, replace the shell with `cat`
  // so sendKeys bytes never reach a shell interpreter.
  await queue.enqueue(leftPaneId, () =>
    tmux.sendKeys({
      socket,
      target: leftPaneId,
      keys: ['clear && exec cat'],
      enter: true,
    }),
  )

  // Per-source tmux sessions are created lazily by the right-pane controller
  // (one session per `registerSource(...)` call). No shared substrate session
  // is created at boot — the visible `orch` session is the only one the host
  // owns. Source sessions live on the same socket and are reaped during
  // teardown via `controller.teardownSessions()`.
  const rightPaneId = await tmux.splitPane({
    socket,
    session: SESSION,
    orientation: 'h',
    percent: RIGHT_PERCENT,
    command: PLACEHOLDER_CMD,
  })
  void opts.logger
    ?.append('lifecycle', { type: 'pane-created', pane: 'R', paneId: rightPaneId })
    .catch(() => {})

  // Under `--no-attach`, the CLI keeps the old hint-only behavior. Under
  // auto-attach (the default), the hint is moot — the attach client takes
  // over the TTY immediately — and would scroll above the two panes.
  if (opts.skipAttach === true) {
    opts.stderr.write(
      `[orch tmux] attach with:   tmux -L ${socket} attach -t ${SESSION}\n` +
        `[orch tmux] clean up with: tmux -L ${socket} kill-server\n`,
    )
  }

  // --debug pipe-pane capture. Kicked off after both panes exist so each
  // pane's initial splash can still land in the log (before `cat` starts).
  // Some tmux builds drop bytes issued before the pipe is installed; the
  // plan (§ Open Questions) accepts that small initial loss.
  const pipePaneCapture =
    opts.logger?.debug && opts.logger.logsDir !== null && opts.fs !== undefined
      ? await startPipePaneCapture({
          tmux,
          fs: opts.fs,
          socket,
          logsDir: opts.logger.logsDir,
          panes: [leftPaneId, rightPaneId],
          onError: (err) => opts.stderr.write(`[orch tmux] pipe-pane: ${String(err)}\n`),
        })
      : undefined

  const stdoutForReset = opts.stdout ?? process.stdout
  const stdioCapture = maybeInstallStdioCapture(opts, stdoutForReset)

  // Latched terminal-reset: on the graceful path `teardown()` hands the
  // TTY back to the CLI; the CLI then writes the success/failure summary
  // and exits. The host must not touch the TTY again on that path. The
  // `process.on('exit', ...)` backstop is the crash-path fallback for
  // hard exits where teardown never ran. Sharing a single latched closure
  // between both call sites keeps the contract "host writes the reset at
  // most once per instance" — which matters on Apple Terminal / iTerm2
  // where `\x1b[?1049l` is a screen-buffer toggle, so a redundant write
  // would switch INTO the alt-screen and bury the CLI's summary.
  let terminalReset = false
  const writeTerminalReset = (): void => {
    if (terminalReset) return
    terminalReset = true
    restoreTerminalModes(stdoutForReset)
  }

  const installExitHandler =
    opts.installExitHandler ?? ((handler: () => void) => process.on('exit', handler))
  installExitHandler(() => {
    writeTerminalReset()
  })

  // Systemic backstop for the fd-2 bleed. The "never write to stderr while
  // attached to tmux" rule is otherwise enforced only by convention at each
  // call site; a single escaped rejection from any `void asyncFn()` would
  // reach Node's default handler and print its stack to the shared TTY, drawing
  // over the live TUI (incident r-2026-05-25-171216-nu). Route every unhandled
  // rejection to the session lifecycle log and swallow it — a logged line, not
  // terminal corruption. Scoped to the tmux host (the only host that shares the
  // TTY), mirroring the exit-handler placement decision.
  const installRejectionHandler =
    opts.installRejectionHandler ??
    ((handler: (reason: unknown) => void) => process.on('unhandledRejection', handler))
  installRejectionHandler((reason: unknown) => {
    void opts.logger
      ?.append('lifecycle', {
        type: 'unhandled-rejection-suppressed',
        error: String(reason),
        ...(reason instanceof Error
          ? { errorName: reason.name, errorMessage: reason.message, stack: reason.stack }
          : {}),
      })
      .catch(() => {})
  })

  // Phase 4 + q/Ctrl-C fix: track which branch settled the foreground
  // shutdown race so the CLI can discriminate a user-quit (tear orch down,
  // do NOT wait on the workflow) from a benign attach exit (keep the
  // workflow running in background). One tagged deferred, settled at most
  // once — first writer wins.
  const shutdownDeferred = createTaggedDeferred<ForegroundShutdownReason>()

  // U5 hoist: create the right-pane controller BEFORE buildHost so the
  // host's lifecycle handlers can call registerSource / unregisterSource
  // / emitBanner directly. The controller does not depend on `innerHost`
  // nor on the steps-view daemon (the daemon consumes the controller's
  // `onIntent`; the controller emits to lifecycle hooks regardless).
  // Create whenever a stateStore + basePath are supplied; tests that omit
  // either get the legacy "no controller" behavior.
  let rightPaneController: RightPaneController | undefined
  if (
    opts.basePath !== undefined &&
    opts.onStepsIntent === undefined &&
    opts.stateStore !== undefined
  ) {
    const stateDir = toPath(`${opts.basePath}/${opts.runId}`)
    const cwdPath = toPath(opts.cwd ?? process.cwd())
    const envForChild = filterDefinedEnv(opts.env ?? process.env)
    rightPaneController = createRightPaneController({
      tmux,
      socket,
      leftPaneId,
      rightPaneId,
      paneQueue: queue,
      stateStore: opts.stateStore,
      runId: opts.runId,
      stateDir,
      cwd: cwdPath,
      env: envForChild,
      stderr: opts.stderr,
      width: WIDTH,
      height: HEIGHT,
      tuiOverlayPath: toPath(`${stateDir}/tui-overlay.ndjson`),
      ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
      ...(opts.resumeRegistry !== undefined ? { resumeRegistry: opts.resumeRegistry } : {}),
      ...(opts.transcriptRenderer !== undefined
        ? { transcriptRenderer: opts.transcriptRenderer }
        : {}),
    })
  }

  // Build the host; startStepsView spawns its child via the host's own
  // `runInteractive({ pane: 'left' })` and the host therefore must exist
  // before the spawn.
  const innerHost = buildHost({
    tmux,
    socket,
    queue,
    leftPaneId,
    rightPaneId,
    stderr: opts.stderr,
    clock: opts.clock,
    runId: opts.runId,
    processService: opts.processService,
    skipAttach: opts.skipAttach === true,
    cwd: opts.cwd ?? process.cwd(),
    stdout: opts.stdout ?? process.stdout,
    writeTerminalReset,
    tee: createPerStepTee(opts.logger),
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
    ...(pipePaneCapture !== undefined ? { pipePaneCapture } : {}),
    ...(stdioCapture !== undefined ? { stdioCapture } : {}),
    ...(rightPaneController !== undefined ? { controller: rightPaneController } : {}),
  })

  let stepsHandle: StartStepsViewHandle | undefined
  if (opts.disableStepsView !== true && opts.basePath !== undefined) {
    const basePath = opts.basePath
    const stateDir = toPath(`${basePath}/${opts.runId}`)
    const cwdPath = toPath(opts.cwd ?? process.cwd())
    const envForChild = filterDefinedEnv(opts.env ?? process.env)

    const baseIntent: ((intent: StepsIntent) => void) | undefined =
      opts.onStepsIntent ?? rightPaneController?.onIntent

    // Compose: forward intents to the original handler AND tag the shutdown
    // deferred as `'quit'` so `awaitForegroundShutdown` reports the reason.
    // The compose stays tiny — the underlying handler still owns its
    // semantics; only the shutdown signal is enriched.
    const composedIntent = (intent: StepsIntent): void => {
      baseIntent?.(intent)
      if (intent.type === 'quit') shutdownDeferred.resolve('quit')
    }

    stepsHandle = await startStepsView({
      host: innerHost,
      tmux,
      socket,
      leftPaneId,
      paneQueue: queue,
      stateDir,
      basePath,
      runId: opts.runId,
      workflowName: opts.workflowName,
      cwd: cwdPath,
      env: envForChild,
      stderr: opts.stderr,
      ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
      onIntent: composedIntent,
    })
  }

  // settleAttach is a NO-OP under `--no-attach` (skipAttach: true): there is
  // no real foreground attach client to "exit," so firing it at startup
  // would settle the tagged deferred to 'attach-exited' before the user
  // ever has a chance to press `q` — and `q` would then be ignored
  // (single-writer-wins). Under real attach, settleAttach fires when the
  // tmux client exits (user detached or session died).
  const skipAttach = opts.skipAttach === true
  const settleAttach = skipAttach
    ? () => {
        /* no real attach to exit — keep the deferred unresolved so a later
           `q` intent can still win the race. */
      }
    : () => shutdownDeferred.resolve('attach-exited')

  return wrapHostWithStepsView(innerHost, stepsHandle, rightPaneController, {
    shutdownPromise: shutdownDeferred.promise,
    settleAttach,
  })
}

interface TaggedDeferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

// Resolves at most once. Late `resolve(...)` calls after the first are
// silently ignored — the foreground-shutdown signal is single-writer; the
// first branch to settle (`quit` from the steps view OR `attach-exited`
// from the tmux client teardown) defines the reason the CLI sees.
function createTaggedDeferred<T>(): TaggedDeferred<T> {
  let resolved = false
  let resolveInner: (value: T) => void = () => {}
  const promise = new Promise<T>((r) => {
    resolveInner = r
  })
  const resolve = (value: T): void => {
    if (resolved) return
    resolved = true
    resolveInner(value)
  }
  return { promise, resolve }
}

function filterDefinedEnv(
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

interface ShutdownDeps {
  readonly shutdownPromise: Promise<ForegroundShutdownReason>
  readonly settleAttach: () => void
}

function wrapHostWithStepsView(
  inner: Host,
  steps: StartStepsViewHandle | undefined,
  controller: RightPaneController | undefined,
  shutdown: ShutdownDeps,
): Host {
  // Wrap attachForeground unconditionally so awaitForegroundShutdown's
  // attach-exited branch settles even when the steps-view daemon is
  // disabled (test fixtures, headless runs).
  const wrappedAttachForeground = async (): Promise<void> => {
    try {
      await inner.attachForeground()
    } finally {
      shutdown.settleAttach()
    }
  }

  // Foreground shutdown signal: returns the reason the race settled. Single
  // tagged deferred — first writer wins ('quit' from a steps-view intent or
  // 'attach-exited' from the attach client lifecycle). Resolved-only (never
  // rejects), so the CLI can `await` without a try/catch.
  const awaitForegroundShutdown = async (): Promise<ForegroundShutdownReason> => {
    return shutdown.shutdownPromise
  }

  if (steps === undefined && controller === undefined) {
    return {
      ...inner,
      attachForeground: wrappedAttachForeground,
      awaitForegroundShutdown,
    }
  }
  // Latch: a second concurrent caller (e.g. a back-to-back SIGINT during
  // teardown) joins the in-flight teardown promise instead of starting a
  // second run. Without this, the inner's `if (torndown) return` makes the
  // second call resolve immediately — the signal handler's
  // `.finally(process.exit)` then fires before `killSession` completes and
  // leaks the tmux session.
  let teardownPromise: Promise<void> | undefined
  const wrappedTeardown = async (): Promise<void> => {
    if (teardownPromise === undefined) {
      teardownPromise = (async () => {
        // Order: stop intent dispatch (controller) first so a late intent can't
        // reach the tearing-down tmux server, then stop the tailer + child,
        // then the inner host (which kills the session).
        if (controller !== undefined) await controller.stop()
        if (steps !== undefined) await steps.stop()
        await inner.teardown()
      })()
    }
    return teardownPromise
  }
  return {
    ...inner,
    attachForeground: wrappedAttachForeground,
    awaitForegroundShutdown,
    teardown: wrappedTeardown,
  }
}

function maybeInstallStdioCapture(
  opts: TmuxHostOptions,
  stdout: NodeJS.WritableStream,
): StdioCapture | undefined {
  if (opts.skipAttach === true) return undefined
  if (opts.logger === undefined || opts.logger.logsDir === null) return undefined
  if ((stdout as NodeJS.WritableStream & { readonly isTTY?: boolean }).isTTY !== true) {
    return undefined
  }
  return installStdioCapture({
    target: opts.logger.streamSink('orch-stdio.log'),
    stdout: stdout as NodeJS.WriteStream,
  })
}

interface BuildHostDeps {
  readonly tmux: TmuxService
  readonly socket: SocketName
  readonly queue: PaneQueue
  readonly leftPaneId: PaneId
  readonly rightPaneId: PaneId
  readonly stderr: NodeJS.WritableStream
  readonly clock: Clock
  readonly runId: RunId
  readonly processService: ProcessService
  /** When true, `attachForeground()` never spawns `tmux attach-session`. */
  readonly skipAttach: boolean
  readonly cwd: string
  readonly stdout: NodeJS.WritableStream
  /**
   * Latched terminal-reset closure shared with the hard-exit backstop in
   * `createTmuxHost`. Called from `teardown()`; the latch guarantees the
   * DEC private-mode resets are emitted at most once per host so the
   * process-exit backstop can't re-touch the TTY after the CLI has
   * written its summary.
   */
  readonly writeTerminalReset: () => void
  readonly logger?: SessionLogger
  /** Per-step formatted_output.* tee. Open/close on step lifecycle, write
   *  before pane-queue enqueue so the file mirrors per-step ordering even
   *  when two parallel branches interleave on the right pane. */
  readonly tee: PerStepTee
  /**
   * Right-pane controller for the pane-map. When present, lifecycle hooks
   * register/unregister `file-tail` sources for autonomous + command live
   * steps, emit banners on cached / failed events, and emit error banners.
   * Optional because some test fixtures construct the host without a steps-
   * view daemon (and therefore without a controller).
   */
  readonly controller?: RightPaneController
  /** --debug pipe-pane capture. Stopped on teardown to drop the pipes. */
  readonly pipePaneCapture?: import('./pipe-pane-capture.ts').PipePaneCapture
  /** Captures workflow-body console/stdout writes while tmux owns the TTY. */
  readonly stdioCapture?: StdioCapture
}

function buildHost(deps: BuildHostDeps): Host {
  const mode: RunMode = 'two-pane'
  let torndown = false
  // Set BEFORE teardown issues kill-session so `attachForeground` can tell
  // "attach client exited because we killed the session" (clean) from
  // "attach client exited on its own" (unexpected — diagnostic to stderr).
  let teardownStarted = false

  const appendLifecycle = async (record: JsonObject): Promise<void> => {
    await deps.logger?.append('lifecycle', record).catch(() => {})
  }

  const appendLifecycleSoon = (record: JsonObject): void => {
    void appendLifecycle(record)
  }

  const tmuxReachability = async (): Promise<JsonObject> => {
    try {
      const serverReachable = await deps.tmux.hasServer({ socket: deps.socket })
      const sessionReachable = serverReachable
        ? await deps.tmux.hasSession({ socket: deps.socket, session: SESSION })
        : false
      return {
        tmuxServerReachable: serverReachable,
        tmuxSessionReachable: sessionReachable,
      }
    } catch (err) {
      return {
        tmuxReachabilityProbeFailed: true,
        ...errorLifecycleFields(err),
      }
    }
  }

  const handleSendError = (err: unknown): void => {
    if (torndown) return
    deps.stderr.write(`[orch tmux] ${String(err)}\n`)
  }

  const writeBanner = (line: string): void => {
    deps.stderr.write(`${line}\n`)
  }

  const onCommandLine = ({ stream, line, step }: CommandLine): void => {
    if (torndown) return
    // Bytes go raw (no `[step] ` prefix) so ANSI passthrough stays
    // byte-for-byte. Per-step formatted_output tee mirrors the bytes for
    // post-mortem grep — same shape as runner transcripts.
    //
    // U5: the live `file-tail` source for this step tails the tee file, so
    // writing to the tee is the only fan-out path. The legacy direct
    // `sendKeys` onto the right pane is gone — it doubled bytes (kernel pty
    // echo) and corrupted ANSI when a replay was swapped in.
    const payload = `${line}\r\n`
    deps.tee.write(step, payload)
    void stream // both streams stream into the same tee in v1
  }

  const controller = deps.controller

  // Right-pane lifecycle choreography lives in its own deep module behind a
  // FIFO queue (see lifecycle-choreographer.ts). The host forwards each event
  // fire-and-forget; the choreographer owns the ordering invariants, the
  // parallel rollup, and the per-step tee/source side effects.
  const choreographer = createLifecycleChoreographer({
    controller,
    tee: deps.tee,
    logger: deps.logger,
    runId: deps.runId,
    clock: deps.clock,
    isTorndown: () => torndown,
    onSendError: handleSendError,
  })

  const onLifecycleEvent = (event: StepLifecycleEvent): void => {
    // The steps-view daemon tails on-disk lifecycle events directly — no
    // in-process forwarding needed. The choreographer drives the right-pane
    // side effects (per-step tee, file-tail source register/unregister,
    // failure summary, parallel rollup) behind its serialization queue.
    void choreographer.handle(event)
  }

  const onRunnerEvent = (
    _event: RunnerEvent,
    step: StepName,
    lines: readonly TranscriptLine[],
  ): void => {
    if (torndown) return
    if (lines.length === 0) return
    // tmux owns the pane, so `color: true` always. Block lines drop the
    // `[step] ` prefix so the heading is the only context anchor — matches
    // the plain host's behaviour byte-for-byte (modulo \r\n vs \n).
    const prefix = `[${step}] `
    const out: string[] = []
    for (const line of lines) {
      const rendered = renderTranscriptLine(line, {
        color: true,
        prefix: line.kind === 'line' ? prefix : '',
      })
      for (const r of rendered) out.push(`${r}\r\n`)
    }
    if (out.length === 0) return
    const payload = out.join('')
    // U5: write to the per-step tee only; the hidden `file-tail` pane
    // registered on `step:start` mirrors the bytes into the visible right
    // pane via `tail -F`. Direct `sendKeys` is gone (it caused the kernel
    // pty echo-doubling bug and corrupted swap-in replays).
    deps.tee.write(step, payload)
  }

  const attach = async (pane: PaneRole): Promise<PaneAttachment> => ({
    pane,
    async detach(): Promise<void> {
      /* current v1 host does not swap views on detach — interactive path
         owns respawn directly via runInteractive(). Kept as a no-op so the
         Host contract is uniform across modes. */
    },
  })

  const runInteractive = async (spawn: InteractiveSpawn): Promise<InteractiveResult> => {
    const startedAt = deps.clock.now()
    const paneRole = spawn.pane ?? 'right'
    appendLifecycleSoon({
      type: 'interactive-start',
      stepName: spawn.stepName,
      pane: paneRole,
      socket: deps.socket,
      argv0: spawn.argv[0] ?? null,
      argc: spawn.argv.length,
      cwd: spawn.cwd,
    })

    // Left-pane spawns (the steps-view daemon) stay on the legacy respawnPane
    // path: the left pane is owned by the steps-view child, never by the
    // pane-map controller. The daemon's lifecycle is bookended by the
    // caller's PaneQueue takeover message on exit, not by a placeholder
    // restore — and the controller's `interactive` source kind would kill
    // the hidden pane on unregister, which is wrong for the daemon path.
    if (paneRole === 'left') {
      const targetPane = deps.leftPaneId
      appendLifecycleSoon({
        type: 'interactive-left-respawn-start',
        stepName: spawn.stepName,
        paneId: targetPane,
      })
      await deps.queue.enqueue(targetPane, () =>
        deps.tmux.respawnPane({
          socket: deps.socket,
          target: targetPane,
          argv: spawn.argv,
          killRunning: true,
          env: spawn.env,
          cwd: spawn.cwd,
        }),
      )
      appendLifecycleSoon({
        type: 'interactive-left-respawn-complete',
        stepName: spawn.stepName,
        paneId: targetPane,
      })
      appendLifecycleSoon({
        type: 'interactive-wait-start',
        stepName: spawn.stepName,
        pane: paneRole,
        paneId: targetPane,
        channel: `pane-exit-${targetPane}`,
      })
      try {
        await deps.tmux.waitFor({
          socket: deps.socket,
          channel: `pane-exit-${targetPane}`,
        })
        appendLifecycleSoon({
          type: 'interactive-wait-complete',
          stepName: spawn.stepName,
          pane: paneRole,
          paneId: targetPane,
          channel: `pane-exit-${targetPane}`,
          durationMs: deps.clock.now() - startedAt,
          exitCodeKnown: false,
        })
      } catch (err) {
        /* left-pane wait failure is non-fatal — the daemon caller handles
           pane takeover on its own. */
        await appendLifecycle({
          type: 'interactive-wait-failed',
          stepName: spawn.stepName,
          pane: paneRole,
          paneId: targetPane,
          channel: `pane-exit-${targetPane}`,
          durationMs: deps.clock.now() - startedAt,
          isSessionLost: isSessionLostError(err),
          ...errorLifecycleFields(err),
          ...(isSessionLostError(err) ? await tmuxReachability() : {}),
        })
      }
      return { exitCode: 0, durationMs: deps.clock.now() - startedAt }
    }

    // Right-pane interactive: U6's pane-map path. Register a `pty` source on
    // the scratch session, swap it into the visible slot, wait for the
    // hidden pane's `pane-died` hook, then unregister (which kills the
    // hidden pane and swaps placeholder back in).
    //
    // The controller is required for this path. When a fixture omits
    // basePath + stateStore, the controller is undefined — that's a wiring
    // error for any interactive test, and we surface it explicitly rather
    // than fall back to the legacy respawnPane path (which would re-
    // introduce the kernel pty echo + ANSI corruption that U5/U6 removed).
    if (controller === undefined) {
      throw new Error(
        'tmux-host.runInteractive: right-pane interactive requires a configured right-pane controller (set basePath + stateStore on createTmuxHost).',
      )
    }
    const sourceKey: SourceKey = { type: 'interactive', stepName: spawn.stepName }
    const sourceKeyString = `interactive:${spawn.stepName}`
    // Auto-stop: allocate a per-step stop channel and inject the socket +
    // channel NAMES the agent's hook references (`$ORCH_SOCKET` /
    // `$ORCH_STOP_CHANNEL`). Injected here so the env is present the instant
    // the pane's process starts. The channel can't embed the pane id — the id
    // doesn't exist until the pane does — so it's keyed off the unique step
    // name instead.
    const autoStopChannel = spawn.autoStop
      ? `auto-stop-${spawn.stepName.replace(/[^a-zA-Z0-9-]/g, '_')}`
      : undefined
    const spawnEnv =
      autoStopChannel !== undefined
        ? { ...spawn.env, ORCH_SOCKET: deps.socket, ORCH_STOP_CHANNEL: autoStopChannel }
        : spawn.env
    try {
      appendLifecycleSoon({
        type: 'interactive-register-start',
        stepName: spawn.stepName,
        sourceKey: sourceKeyString,
        argv0: spawn.argv[0] ?? null,
        argc: spawn.argv.length,
        cwd: spawn.cwd,
      })
      // registerSource spawns a hidden pane in the scratch session with the
      // runner argv + env + cwd; the pane is a real PTY (isTTY === true) so
      // arrow keys / Ctrl-C / resize reflow / color all work natively.
      await controller.registerSource(sourceKey, {
        kind: 'pty',
        argv: spawn.argv,
        env: spawnEnv,
        cwd: spawn.cwd,
      })
    } catch (err) {
      // The user-reported "[server exited]" crash hits here when the tmux
      // session died externally between steps: the per-source `createSession`
      // (or the older `splitPane`) against the dead socket fails. Translate
      // it into the typed `HostUnavailableError` so the CLI renders a clean
      // failure summary instead of an unwrapped `TmuxCommandError`.
      //
      // Two classification paths: the canonical session-lost stderr shape
      // (`isSessionLostError`), OR a live reachability probe that finds the
      // visible `orch` session gone. The reachability path catches the U4
      // shift where `new-session` re-creates the server (so the next call
      // succeeds against a fresh server) but the visible `orch` session is
      // still missing — semantically still "host unavailable".
      const reachability = await tmuxReachability()
      const sessionLost = isSessionLostError(err) || reachability.tmuxSessionReachable === false
      await appendLifecycle({
        type: 'interactive-register-failed',
        stepName: spawn.stepName,
        sourceKey: sourceKeyString,
        isSessionLost: sessionLost,
        ...errorLifecycleFields(err),
        ...reachability,
      })
      if (sessionLost) {
        throw new HostUnavailableError(
          `tmux session is no longer reachable — cannot start interactive step ${spawn.stepName}`,
          err,
        )
      }
      throw err
    }
    appendLifecycleSoon({
      type: 'interactive-register-complete',
      stepName: spawn.stepName,
      sourceKey: sourceKeyString,
    })
    const hiddenPaneId = controller.getPaneId(sourceKey)
    if (hiddenPaneId === undefined) {
      // Should never happen — registerSource just succeeded. Defensive
      // throw rather than silently waiting on a stale visible-pane id.
      throw new Error(
        `tmux-host.runInteractive: controller.getPaneId returned undefined immediately after registerSource for ${spawn.stepName}`,
      )
    }
    appendLifecycleSoon({
      type: 'interactive-hidden-pane-ready',
      stepName: spawn.stepName,
      sourceKey: sourceKeyString,
      paneId: hiddenPaneId,
    })
    try {
      // Swap visible ↔ hidden so the interactive pane is what the user sees.
      appendLifecycleSoon({
        type: 'interactive-show-start',
        stepName: spawn.stepName,
        sourceKey: sourceKeyString,
        paneId: hiddenPaneId,
      })
      await controller.showSource(sourceKey)
      appendLifecycleSoon({
        type: 'interactive-show-complete',
        stepName: spawn.stepName,
        sourceKey: sourceKeyString,
        paneId: hiddenPaneId,
      })
      appendLifecycleSoon({
        type: 'interactive-wait-start',
        stepName: spawn.stepName,
        pane: paneRole,
        paneId: hiddenPaneId,
        channel: `pane-exit-${hiddenPaneId}`,
      })
      // Wait on the HIDDEN pane id's pane-died hook. The global hook
      // installed by `initOrchSession` fires for any pane death on the
      // server (cross-session OK), so `pane-exit-<hiddenPaneId>` resolves
      // when the runner exits even though the pane lives in the scratch
      // session.
      //
      // With auto-stop armed, race that pane-exit wait against the stop
      // channel the agent's hook signals on turn completion. A manual human
      // close still resolves via pane-exit (the non-autoStop path is
      // unchanged); a stop signal triggers an external termination (clean EOF
      // first, kill-session teardown as the bounded fallback).
      const paneExitChannel = `pane-exit-${hiddenPaneId}`
      let paneExitVia: PaneExitOutcome['via'] | undefined
      if (autoStopChannel === undefined) {
        const outcome = await awaitInteractivePaneExit(
          deps.tmux,
          deps.socket,
          hiddenPaneId,
          paneExitChannel,
          deps.clock,
        )
        paneExitVia = outcome.via
        if (outcome.via === 'liveness-poll') {
          // The hook signal was lost/delayed; the poll observed the dead pane
          // and short-circuited the wait. Log it so a recurring backstop hit
          // is visible in lifecycle.ndjson rather than silently absorbed.
          appendLifecycleSoon({
            type: 'interactive-wait-hook-missed',
            stepName: spawn.stepName,
            pane: paneRole,
            paneId: hiddenPaneId,
            channel: paneExitChannel,
            deadStatus: outcome.deadStatus ?? null,
          })
        }
      } else {
        appendLifecycleSoon({
          type: 'interactive-auto-stop-armed',
          stepName: spawn.stepName,
          pane: paneRole,
          paneId: hiddenPaneId,
          channel: autoStopChannel,
        })
        const winner = await racePaneExitVsStop(
          deps.tmux,
          deps.socket,
          paneExitChannel,
          autoStopChannel,
        )
        if (winner === 'stop') {
          appendLifecycleSoon({
            type: 'interactive-auto-stop-signaled',
            stepName: spawn.stepName,
            paneId: hiddenPaneId,
            channel: autoStopChannel,
          })
          const terminationPath = await terminateOnAutoStop(
            deps.tmux,
            deps.socket,
            hiddenPaneId,
            paneExitChannel,
          )
          appendLifecycleSoon({
            type: 'interactive-auto-stop-terminated',
            stepName: spawn.stepName,
            paneId: hiddenPaneId,
            path: terminationPath,
          })
        }
      }
      appendLifecycleSoon({
        type: 'interactive-wait-complete',
        stepName: spawn.stepName,
        pane: paneRole,
        paneId: hiddenPaneId,
        channel: `pane-exit-${hiddenPaneId}`,
        durationMs: deps.clock.now() - startedAt,
        exitCodeKnown: false,
        via: paneExitVia ?? null,
      })
    } catch (err) {
      // Same dual-path classification as the register-failed catch above:
      // canonical session-lost stderr OR a live reachability probe that
      // finds the visible `orch` session gone. Covers both the legacy
      // "dead socket" failure shape and the U4-era "server re-created via
      // new-session, but orch session still missing" shape (e.g. the swap
      // fails with "can't find pane").
      const reachability = await tmuxReachability()
      const sessionLost = isSessionLostError(err) || reachability.tmuxSessionReachable === false
      await appendLifecycle({
        type: 'interactive-wait-failed',
        stepName: spawn.stepName,
        pane: paneRole,
        paneId: hiddenPaneId,
        channel: `pane-exit-${hiddenPaneId}`,
        durationMs: deps.clock.now() - startedAt,
        isSessionLost: sessionLost,
        ...errorLifecycleFields(err),
        ...reachability,
      })
      if (sessionLost) {
        // Best-effort cleanup before surfacing the typed error — the
        // hidden pane is already dead with the server, but `unregisterSource`
        // also drops the in-memory bookkeeping. Failure here is expected
        // (still talking to the dead socket) and silently dropped.
        await controller.unregisterSource(sourceKey).catch(() => {})
        throw new HostUnavailableError(
          `tmux session is no longer reachable — interactive step ${spawn.stepName} cannot continue`,
          err,
        )
      }
      throw err
    } finally {
      // Auto-stop: release any parked stop-channel waiter. If the pane closed
      // some other way (manual human close → pane-exit won the race, or an
      // error path), the stop-channel `tmux wait-for` client is still blocked;
      // signalling the channel lets it exit instead of lingering. Idempotent
      // and harmless when the channel was already the winner.
      if (autoStopChannel !== undefined) {
        await deps.tmux
          .signalChannel({ socket: deps.socket, channel: autoStopChannel })
          .catch(() => {})
      }
      // unregisterSource for `interactive` kills the hidden pane and (if
      // the interactive source was current) swaps the placeholder back to
      // the visible slot. The old post-exit `respawnPane(['cat'])` restore
      // is gone — the visible right pane never ran the runner argv
      // directly, so there's nothing on it to clean up.
      appendLifecycleSoon({
        type: 'interactive-unregister-start',
        stepName: spawn.stepName,
        sourceKey: sourceKeyString,
        paneId: hiddenPaneId,
      })
      await controller
        .unregisterSource(sourceKey)
        .then(() =>
          appendLifecycle({
            type: 'interactive-unregister-complete',
            stepName: spawn.stepName,
            sourceKey: sourceKeyString,
            paneId: hiddenPaneId,
          }),
        )
        .catch((err) => {
          appendLifecycleSoon({
            type: 'interactive-unregister-failed',
            stepName: spawn.stepName,
            sourceKey: sourceKeyString,
            paneId: hiddenPaneId,
            ...errorLifecycleFields(err),
          })
          handleSendError(err)
        })
      // Run the runner's auto-stop artifact cleanup (Claude's settings file,
      // Codex's temp CODEX_HOME) after the pane is gone. Guarded so a cleanup
      // failure is logged, never thrown out of `finally`.
      if (spawn.onCleanup !== undefined) {
        await spawn.onCleanup().catch((err) => {
          appendLifecycleSoon({
            type: 'interactive-auto-stop-cleanup-failed',
            stepName: spawn.stepName,
            ...errorLifecycleFields(err),
          })
        })
      }
    }

    // tmux's `pane-died` hook doesn't give us the child's exit code through
    // the wait-for channel. The interactive pane is best-effort; we treat a
    // clean exit as exit 0. Phase D2 will wire structured failure capture.
    return { exitCode: 0, durationMs: deps.clock.now() - startedAt }
  }

  const rawAttachForeground = createAttachForeground({
    processService: deps.processService,
    socket: deps.socket,
    stderr: deps.stderr,
    cwd: deps.cwd,
    skipAttach: deps.skipAttach,
    isTeardownStarted: () => teardownStarted,
  })

  // Wrap so the logger observes the attach lifetime without every internal
  // path of `createAttachForeground` needing to know about it.
  const attachForeground = async (): Promise<void> => {
    appendLifecycleSoon({ type: 'attach-foreground-started' })
    let attachResult:
      | {
          readonly skipped: boolean
          readonly exitCode: number | null
          readonly teardownStarted: boolean
        }
      | undefined
    let attachError: unknown
    try {
      attachResult = await rawAttachForeground()
    } catch (err) {
      attachError = err
      throw err
    } finally {
      await appendLifecycle({
        type: 'attach-foreground-exited',
        skipped: attachResult?.skipped ?? false,
        exitCode: attachResult?.exitCode ?? null,
        teardownStarted: attachResult?.teardownStarted ?? teardownStarted,
        ...(attachError === undefined ? {} : errorLifecycleFields(attachError)),
        ...(await tmuxReachability()),
      })
    }
  }

  // Latch: a second concurrent caller joins the in-flight teardown promise
  // instead of seeing the `torndown` short-circuit and resolving early.
  // Critical for the back-to-back SIGINT path — a fire-and-forget
  // `host.teardown().finally(process.exit)` must wait for `killSession` even
  // on the second invocation. `torndown` is retained as a true post-cleanup
  // idempotency guard for callers that arrive after the promise has settled.
  let innerTeardownPromise: Promise<void> | undefined
  const teardownInner = async (): Promise<void> => {
    if (torndown) return
    // Order matters: flip `teardownStarted` BEFORE killSession so the attach
    // client exit (triggered by kill-session) routes through the "expected"
    // branch in `attachForeground`, not the "attach died unexpectedly" path.
    teardownStarted = true
    torndown = true
    // Let any queued lifecycle choreography settle before draining the tee —
    // pending `handle()` work may still hold a tee sink open, and draining
    // mid-write would race a close against a write (KTD6).
    await choreographer.quiescent()
    // Flush any open per-step formatted_output sinks so SIGINT mid-step
    // still leaves bytes on disk before the run-ended record.
    await deps.tee.drain()
    await deps.queue.drain()
    if (deps.stdioCapture !== undefined) {
      await deps.stdioCapture.restore()
    }
    // Stop pipe-pane capture BEFORE killSession so tmux closes the pipe
    // cleanly instead of ripping the `cat` process out from under the pane.
    if (deps.pipePaneCapture !== undefined) {
      await deps.pipePaneCapture.stop()
    }
    // Tear down every per-source session BEFORE killing the visible `orch`
    // session so hidden source panes can never outlive their swap target.
    // The controller owns the per-source session map; `teardownSessions` is
    // idempotent and isolates per-entry failures (one already-gone session
    // does not block the others). When no controller is wired (test fixtures
    // that omit basePath + stateStore), no source sessions exist and there
    // is nothing to reap here.
    if (deps.controller !== undefined) {
      try {
        await deps.controller.teardownSessions()
      } catch (err) {
        appendLifecycleSoon({
          type: 'source-sessions-teardown-failed',
          ...errorLifecycleFields(err),
        })
        deps.stderr.write(`[orch tmux] source-sessions teardown failed: ${String(err)}\n`)
      }
    }
    // Kill the session last so all pending writes have already drained.
    // `killSession` tolerates "session not found" — a racing teardown or an
    // already-gone server is the outcome we want.
    appendLifecycleSoon({
      type: 'tmux-session-teardown-start',
      socket: deps.socket,
      session: SESSION,
    })
    try {
      await deps.tmux.killSession({ socket: deps.socket, session: SESSION })
    } catch (err) {
      appendLifecycleSoon({
        type: 'tmux-session-teardown-failed',
        socket: deps.socket,
        session: SESSION,
        ...errorLifecycleFields(err),
      })
      deps.stderr.write(`[orch tmux] kill-session failed: ${String(err)}\n`)
    }
    // Explicit kill-server. The appliance config pins `exit-empty off` so the
    // server stays alive even after both sessions are killed (intentional —
    // it lets us survive a momentary pane-less window without dissolving the
    // server, see incident r-2026-05-22-093650-j0). Teardown therefore has
    // to take the server down itself; idempotent against "no server running".
    appendLifecycleSoon({ type: 'tmux-server-teardown-start', socket: deps.socket })
    try {
      await deps.tmux.killServer({ socket: deps.socket })
    } catch (err) {
      appendLifecycleSoon({
        type: 'tmux-server-teardown-failed',
        socket: deps.socket,
        ...errorLifecycleFields(err),
      })
      deps.stderr.write(`[orch tmux] kill-server failed: ${String(err)}\n`)
    }
    // Restore DEC private modes the attach client may have left on the outer
    // TTY (mouse tracking, alt-screen, bracketed paste). Safe no-op when
    // `stdout.isTTY` is false (pipes, tests). The latched closure ensures
    // the process-exit backstop in `createTmuxHost` cannot re-emit and
    // toggle Apple Terminal / iTerm2 back into the alt-screen.
    deps.writeTerminalReset()
    void deps.logger?.append('lifecycle', { type: 'host-torndown', mode }).catch(() => {})
    orchLog(deps.logger, 'host-teardown', { mode })
  }
  const teardown = async (): Promise<void> => {
    if (innerTeardownPromise !== undefined) return innerTeardownPromise
    innerTeardownPromise = teardownInner()
    return innerTeardownPromise
  }

  // Inner stub: `wrapHostWithStepsView` always replaces this with a real
  // implementation that races the quit + attach signals. Kept as a stub so
  // the inner Host satisfies the port type even when constructed in
  // isolation (e.g. exhaustive type-checks on every Host return shape).
  // Treats a stub call as `attach-exited` — the absence of a quit pathway
  // is the right default.
  const awaitForegroundShutdown = async (): Promise<ForegroundShutdownReason> => {
    return 'attach-exited'
  }

  const probeReachability = async (): Promise<{
    readonly reachable: boolean
    readonly reason?: string
  }> => {
    // Reuse the existing internal probe — it already handles the both-sessions
    // + probe-failed cases used for lifecycle telemetry. Compress the JsonObject
    // result down to the boolean+reason shape the Host interface promises.
    const probe = await tmuxReachability()
    if (probe.tmuxReachabilityProbeFailed === true) {
      return {
        reachable: false,
        reason: 'tmux server is no longer reachable',
      }
    }
    if (probe.tmuxServerReachable === false) {
      return {
        reachable: false,
        reason: 'tmux server is no longer reachable',
      }
    }
    if (probe.tmuxSessionReachable === false) {
      return {
        reachable: false,
        reason: 'tmux session is no longer reachable',
      }
    }
    return { reachable: true }
  }

  return {
    mode,
    writeBanner,
    onRunnerEvent,
    onLifecycleEvent,
    onCommandLine,
    attach,
    runInteractive,
    attachForeground,
    awaitForegroundShutdown,
    probeReachability,
    teardown,
  }
}
