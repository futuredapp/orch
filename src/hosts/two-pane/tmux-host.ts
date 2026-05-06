// ---------------------------------------------------------------------------
// TmuxHost — the `--mode=two-pane` implementation of the Host port.
// ---------------------------------------------------------------------------
//
// Two panes: left runs a `cat` placeholder with the status rollup drawn into
// it; right runs a `cat` placeholder that receives transcript lines (for
// autonomous steps) or is respawned with the runner argv (for interactive
// steps). The placeholders matter — `send-keys -l` writes bytes to the pane's
// stdin, so if the pane ran a shell, every transcript line would be shell
// input. `cat` just echoes; any future swap of the placeholder must be a
// non-interpreting process (see tmux-service's respawn-pane contract).
//
// Every pane write goes through the shared PaneQueue — transcript fan-out,
// status rollup, and respawn-pane -k all serialize per pane so a pending
// transcript keystroke can never land on an interactive process that just
// took the pane over.

import { summarizeFailure } from '../../core/failure-summary.ts'
import type { RunMode } from '../../core/run-mode.ts'
import type { RunId, StepName } from '../../core/types.ts'
import type { StepLifecycleEvent } from '../../core/workflow.ts'
import {
  orchLog,
  type SessionLogger,
  type StatusLoop,
  startStatusLoop,
} from '../../observability/index.ts'
import type { RunnerEvent, TranscriptLine } from '../../runners/index.ts'
import type { Clock } from '../../services/clock/index.ts'
import type { FsService } from '../../services/fs/index.ts'
import { BunFsService } from '../../services/fs/index.ts'
import type { ProcessService } from '../../services/process/index.ts'
import type { PaneId, SocketName, TmuxService } from '../../services/tmux/index.ts'
import { initOrchSession, paneId, RealTmuxService, socketName } from '../../services/tmux/index.ts'
import type {
  CommandLine,
  Host,
  InteractiveResult,
  InteractiveSpawn,
  PaneAttachment,
  PaneRole,
} from '../host.ts'
import { createPerStepTee, type PerStepTee } from '../plain/per-step-tee.ts'
import { renderTranscriptLine } from '../plain/render-line.ts'
import { assertNoNestedTmux, createAttachForeground } from './attach-foreground.ts'
import { renderFailurePanePayload } from './failure-pane.ts'
import { createPaneQueue, type PaneQueue } from './pane-queue.ts'
import {
  createRollupAggregator,
  type RollupAggregator,
  renderRollupPayload,
} from './parallel-rollup.ts'
import { startPipePaneCapture } from './pipe-pane-capture.ts'
import { installStdioCapture, type StdioCapture } from './stdio-capture.ts'
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

  const statusLoop: StatusLoop = startStatusLoop({
    tmux,
    socket,
    target: leftPaneId,
    clock: opts.clock,
    runTitle: opts.workflowName,
    onError: (err) => opts.stderr.write(`[orch tmux] ${String(err)}\n`),
  })

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

  // Hard-exit backstop. Graceful exits route through `teardown()`, which
  // also calls `restoreTerminalModes`; this catches the cases where a hard
  // `process.exit()` (unhandled error, signal handler timeout) skips
  // teardown entirely. Idempotent — if both fire, the second write is a
  // no-op on a clean terminal. Registered only after the tmux session
  // actually exists, so no other code path leaks the resets to stdout.
  const installExitHandler =
    opts.installExitHandler ?? ((handler: () => void) => process.on('exit', handler))
  installExitHandler(() => {
    restoreTerminalModes(stdoutForReset)
  })

  return buildHost({
    tmux,
    socket,
    queue,
    leftPaneId,
    rightPaneId,
    statusLoop,
    stderr: opts.stderr,
    clock: opts.clock,
    runId: opts.runId,
    processService: opts.processService,
    skipAttach: opts.skipAttach === true,
    cwd: opts.cwd ?? process.cwd(),
    stdout: opts.stdout ?? process.stdout,
    tee: createPerStepTee(opts.logger),
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
    ...(pipePaneCapture !== undefined ? { pipePaneCapture } : {}),
    ...(stdioCapture !== undefined ? { stdioCapture } : {}),
  })
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
  readonly statusLoop: StatusLoop
  readonly stderr: NodeJS.WritableStream
  readonly clock: Clock
  readonly runId: RunId
  readonly processService: ProcessService
  /** When true, `attachForeground()` never spawns `tmux attach-session`. */
  readonly skipAttach: boolean
  readonly cwd: string
  readonly stdout: NodeJS.WritableStream
  readonly logger?: SessionLogger
  /** Per-step formatted_output.* tee. Open/close on step lifecycle, write
   *  before pane-queue enqueue so the file mirrors per-step ordering even
   *  when two parallel branches interleave on the right pane. */
  readonly tee: PerStepTee
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
  const rollup: RollupAggregator = createRollupAggregator()

  const handleSendError = (err: unknown): void => {
    if (torndown) return
    deps.stderr.write(`[orch tmux] ${String(err)}\n`)
  }

  const writeBanner = (line: string): void => {
    deps.stderr.write(`${line}\n`)
  }

  const enqueueOnPane = (paneId: PaneId, payload: string): void => {
    if (torndown) return
    void deps.queue
      .enqueue(paneId, () =>
        deps.tmux.sendKeys({
          socket: deps.socket,
          target: paneId,
          keys: [payload],
        }),
      )
      .catch(handleSendError)
  }

  const enqueueRight = (payload: string): void => {
    enqueueOnPane(deps.rightPaneId, payload)
  }

  const onCommandLine = ({ stream, line, step, pane }: CommandLine): void => {
    if (torndown) return
    // Bytes go raw (no `[step] ` prefix) so ANSI passthrough stays
    // byte-for-byte. Per-step formatted_output tee mirrors the bytes for
    // post-mortem grep — same shape as runner transcripts.
    const payload = `${line}\r\n`
    deps.tee.write(step, payload)
    const target = pane === 'left' ? deps.leftPaneId : deps.rightPaneId
    enqueueOnPane(target, payload)
    void stream // both streams stream into the same pane in v1
  }

  const onLifecycleEvent = (event: StepLifecycleEvent): void => {
    deps.statusLoop.onStepEvent(event)
    // Open/close per-step formatted_output.* sinks alongside the on-pane
    // bytes. The tee writes happen inside onRunnerEvent (below) before
    // pane-queue enqueue so the per-step file mirrors per-step ordering.
    if (event.type === 'step:start' && event.mode === 'autonomous') {
      deps.tee.open(event.stepName)
    } else if (event.type === 'step:complete' || event.type === 'step:failed') {
      deps.tee.close(event.stepName)
    }
    if (event.type === 'step:failed' && !torndown) {
      const summary = summarizeFailure({
        stepName: event.stepName,
        runId: deps.runId,
        error: event.error,
        failedAt: deps.clock.now(),
      })
      enqueueRight(renderFailurePanePayload(summary))
      return
    }
    if (event.type === 'step:parallel-branch-update') {
      // Aggregate first, then render the compact rollup. Rollup renders on
      // every update so branches that finish mid-rollup flip their glyph in
      // place. Per-branch transcripts still flow through onRunnerEvent —
      // they interleave with rollup frames in the right pane for v1. A
      // dedicated rollup-only pane is a v2 concern.
      const snapshot = rollup.apply({
        stepName: event.stepName,
        branchStatus: event.branchStatus,
        ...(event.elapsedMs !== undefined ? { elapsedMs: event.elapsedMs } : {}),
        ...(event.toolCount !== undefined ? { toolCount: event.toolCount } : {}),
      })
      enqueueRight(renderRollupPayload(snapshot))
    }
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
    // Tee BEFORE pane-queue enqueue so the per-step file reflects per-step
    // ordering even when parallel branches interleave on the right pane.
    deps.tee.write(step, payload)
    void deps.queue
      .enqueue(deps.rightPaneId, () =>
        deps.tmux.sendKeys({
          socket: deps.socket,
          target: deps.rightPaneId,
          keys: [payload],
        }),
      )
      .catch(handleSendError)
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

    // respawn-pane enqueues behind any pending sendKeys on the right pane so
    // no transcript keystroke races the interactive child's stdin.
    // `env: spawn.env` carries the runner's full env (built via mergeEnv) into
    // the child via tmux's `-e KEY=VAL` flags — the only seam where the
    // interactive agent picks up `ANTHROPIC_API_KEY`, OAuth keychain bootstrap
    // vars, and `FORCE_COLOR=3` for Claude.
    // `cwd: spawn.cwd` becomes tmux's `-c <dir>` flag — without it, the pane
    // keeps the cwd it was created with, which is `/` (RealTmuxService runs
    // every tmux subprocess from `/`). The agent then can't write to its
    // project files.
    await deps.queue.enqueue(deps.rightPaneId, () =>
      deps.tmux.respawnPane({
        socket: deps.socket,
        target: deps.rightPaneId,
        argv: spawn.argv,
        killRunning: true,
        env: spawn.env,
        cwd: spawn.cwd,
      }),
    )

    // The global `pane-died` hook (installed by `initOrchSession`) signals
    // `pane-exit-<paneId>` when the child exits. Interactive steps wait
    // indefinitely — the agent's `pane-died` hook is the only signal that
    // can release this wait, and the user may pause the agent for arbitrary
    // periods. Autonomous callers can still pass `timeoutMs` to bound their
    // own waits.
    try {
      await deps.tmux.waitFor({
        socket: deps.socket,
        channel: `pane-exit-${deps.rightPaneId}`,
      })
    } finally {
      // Restore the `cat` placeholder so the next autonomous step's
      // transcript has a pane to write to.
      await deps.queue
        .enqueue(deps.rightPaneId, () =>
          deps.tmux.respawnPane({
            socket: deps.socket,
            target: deps.rightPaneId,
            argv: [PLACEHOLDER_CMD],
            killRunning: true,
          }),
        )
        .catch(handleSendError)
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
    void deps.logger?.append('lifecycle', { type: 'attach-foreground-started' }).catch(() => {})
    try {
      await rawAttachForeground()
    } finally {
      void deps.logger?.append('lifecycle', { type: 'attach-foreground-exited' }).catch(() => {})
    }
  }

  const teardown = async (): Promise<void> => {
    if (torndown) return
    // Order matters: flip `teardownStarted` BEFORE killSession so the attach
    // client exit (triggered by kill-session) routes through the "expected"
    // branch in `attachForeground`, not the "attach died unexpectedly" path.
    teardownStarted = true
    torndown = true
    deps.statusLoop.stop()
    rollup.reset()
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
    // Kill the session last so all pending writes have already drained.
    // `killSession` tolerates "session not found" — a racing teardown or an
    // already-gone server is the outcome we want.
    try {
      await deps.tmux.killSession({ socket: deps.socket, session: SESSION })
    } catch (err) {
      deps.stderr.write(`[orch tmux] kill-session failed: ${String(err)}\n`)
    }
    // Restore DEC private modes the attach client may have left on the outer
    // TTY (mouse tracking, alt-screen, bracketed paste). Safe no-op when
    // `stdout.isTTY` is false (pipes, tests).
    restoreTerminalModes(deps.stdout)
    void deps.logger?.append('lifecycle', { type: 'host-torndown', mode }).catch(() => {})
    orchLog(deps.logger, 'host-teardown', { mode })
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
    teardown,
  }
}
