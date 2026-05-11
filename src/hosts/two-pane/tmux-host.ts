// ---------------------------------------------------------------------------
// TmuxHost — the `--mode=two-pane` implementation of the Host port.
// ---------------------------------------------------------------------------
//
// Two panes: left runs a `cat` placeholder with the status rollup drawn into
// it; right is a *swap target* for the pane-map controller (post-2026-05-11
// unified-pane-map plan). Hidden source panes — runner PTYs, `tail -F` over
// per-step tees, the parallel-block rollup tail — live on a sibling tmux
// session (`orch-scratch`) and are `tmux swap-pane`d into the visible right
// slot on demand. The visible right pane never directly hosts a runner
// process; bytes always arrive via swap. The left pane is unchanged (still
// owns the steps-view daemon).
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

import { summarizeFailure } from '../../core/failure-summary.ts'
import type { RunMode } from '../../core/run-mode.ts'
import { metaStepName, type RunId, type StepName } from '../../core/types.ts'
import type { StepLifecycleEvent } from '../../core/workflow.ts'
import { orchLog, type SessionLogger } from '../../observability/index.ts'
import type { RunnerEvent, TranscriptLine } from '../../runners/index.ts'
import type { Clock } from '../../services/clock/index.ts'
import type { FsService } from '../../services/fs/index.ts'
import { BunFsService } from '../../services/fs/index.ts'
import type { ProcessService } from '../../services/process/index.ts'
import type { PaneId, SocketName, TmuxService } from '../../services/tmux/index.ts'
import { initOrchSession, paneId, RealTmuxService, socketName } from '../../services/tmux/index.ts'
import type { Path } from '../../services/types.ts'
import { path as toPath } from '../../services/types.ts'
import type { StateStore } from '../../state/index.ts'
import type {
  CommandLine,
  Host,
  InteractiveResult,
  InteractiveSpawn,
  PaneAttachment,
  PaneRole,
} from '../host.ts'
import { createPerStepTee, type PerStepTee, teePathFor } from '../plain/per-step-tee.ts'
import { renderTranscriptLine } from '../plain/render-line.ts'
import { assertNoNestedTmux, createAttachForeground } from './attach-foreground.ts'
import { renderFailurePanePayload } from './failure-pane.ts'
import {
  createRightPaneController,
  createScratchSession,
  type RightPaneController,
  type ScratchSessionHandle,
  type SourceKey,
  teardownScratchSession,
} from './pane-map/index.ts'
import { createPaneQueue, type PaneQueue } from './pane-queue.ts'
import {
  createRollupAggregator,
  type RollupAggregator,
  renderRollupPayload,
} from './parallel-rollup.ts'
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
// U7: fixed meta step key for the parallel-block rollup tee + hidden pane.
// Leading underscore keeps it out of the user-facing `stepName()` namespace
// and sorts above step names in directory listings.
const ROLLUP_STEP_NAME = metaStepName('_rollup')
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
   * Phase 3 resume launcher. When provided, agent-interactive Enter calls
   * `resumeRunner.resumeCommand(...)` and spawns the resume CLI in window 1.
   * The CLI usually forwards the workflow's primary runner; tests omit to
   * exercise the refusal path.
   */
  readonly resumeRunner?: import('../../runners/types.ts').Runner
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

  // Bootstrap ordering: the scratch session is created BEFORE the visible
  // right-pane split. If scratch creation fails (fd exhaustion, server
  // OOM, etc.), the visible right pane has not yet been split — so no
  // orphaned UI exists and the error bubbles up cleanly to the run
  // startup path.
  const scratchSession = await createScratchSession({
    tmux,
    socket,
    width: WIDTH,
    height: HEIGHT,
  })
  void opts.logger
    ?.append('lifecycle', {
      type: 'scratch-session-created',
      socket,
      session: scratchSession.session,
    })
    .catch(() => {})

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

  // Phase 4: track quit-intent + attach exit for awaitForegroundShutdown. We
  // settle each deferred at most once; the host's awaitForegroundShutdown
  // races them so the CLI can keep the TUI mounted past workflow completion.
  const quitDeferred = createDeferred()
  const attachDeferred = createDeferred()

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
      scratchSession,
      tuiOverlayPath: toPath(`${stateDir}/tui-overlay.ndjson`),
      ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
      ...(opts.resumeRunner !== undefined ? { resumeRunner: opts.resumeRunner } : {}),
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
    tee: createPerStepTee(opts.logger),
    scratchSession,
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

    // Compose: forward intents to the original handler AND mark the quit
    // deferred so `awaitForegroundShutdown` can resolve. The compose stays
    // tiny — the underlying handler still owns its semantics.
    const composedIntent = (intent: StepsIntent): void => {
      baseIntent?.(intent)
      if (intent.type === 'quit') quitDeferred.resolve()
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

  return wrapHostWithStepsView(innerHost, stepsHandle, rightPaneController, {
    quitPromise: quitDeferred.promise,
    attachPromise: attachDeferred.promise,
    settleAttach: attachDeferred.resolve,
  })
}

interface Deferred {
  readonly promise: Promise<void>
  readonly resolve: () => void
}

function createDeferred(): Deferred {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((r) => {
    resolve = r
  })
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
  readonly quitPromise: Promise<void>
  readonly attachPromise: Promise<void>
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

  // Foreground shutdown signal: whichever of (attach exited | quit pressed)
  // settles first. Both are resolved-only (never reject), so Promise.race is
  // safe — no rejection short-circuit can leak through.
  const awaitForegroundShutdown = async (): Promise<void> => {
    await Promise.race([shutdown.quitPromise, shutdown.attachPromise])
  }

  if (steps === undefined && controller === undefined) {
    return {
      ...inner,
      attachForeground: wrappedAttachForeground,
      awaitForegroundShutdown,
    }
  }
  return {
    ...inner,
    attachForeground: wrappedAttachForeground,
    awaitForegroundShutdown,
    teardown: async () => {
      // Order: stop intent dispatch (controller) first so a late intent can't
      // reach the tearing-down tmux server, then stop the tailer + child,
      // then the inner host (which kills the session).
      if (controller !== undefined) await controller.stop()
      if (steps !== undefined) await steps.stop()
      await inner.teardown()
    },
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
  readonly logger?: SessionLogger
  /** Per-step formatted_output.* tee. Open/close on step lifecycle, write
   *  before pane-queue enqueue so the file mirrors per-step ordering even
   *  when two parallel branches interleave on the right pane. */
  readonly tee: PerStepTee
  /** Per-run scratch session that hosts hidden panes for the pane-map. */
  readonly scratchSession: ScratchSessionHandle
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
  const rollup: RollupAggregator = createRollupAggregator()

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

  const onLifecycleEvent = (event: StepLifecycleEvent): void => {
    // The steps-view daemon tails on-disk lifecycle events directly — no
    // in-process forwarding needed. This handler manages right-pane side
    // effects (per-step tee, file-tail source register/unregister, failure
    // summary, parallel rollup).
    if (event.type === 'step:start' && event.mode === 'autonomous') {
      deps.tee.open(event.stepName)
      // U5: wire a live file-tail source. When `logsDir` is null (no file
      // logging configured) the tee writes are a no-op; surface that to
      // the user so the empty right pane has a one-time explanation.
      const teePath = teePathFor(deps.logger, event.stepName)
      if (teePath !== null) {
        void controller
          ?.registerSource(
            { type: 'live', stepName: event.stepName },
            { kind: 'file-tail', path: teePath },
          )
          .catch(handleSendError)
      } else if (controller !== undefined) {
        void controller
          .emitBanner({
            kind: 'info',
            text: `step ${event.stepName} running (no transcript captured — file logging disabled)`,
            ttlMs: 4000,
          })
          .catch(handleSendError)
      }
      return
    }
    if (event.type === 'step:cached') {
      // Cached steps never run on the right pane — surface the cache hit as
      // a transient info banner so the user understands why no transcript
      // appeared. `viewMode` is unchanged (no pane swap occurred).
      void controller
        ?.emitBanner({
          kind: 'info',
          text: `step ${event.stepName} — cached (no transcript captured)`,
          ttlMs: 4000,
        })
        .catch(handleSendError)
      return
    }
    if (event.type === 'step:complete') {
      // Ordering: unregister BEFORE close. The controller's `live → replay`
      // transform leaves the hidden pane alive tailing the tee; the pane
      // continues to see bytes until the tee actually closes. Bytes written
      // between unregister and close (e.g. trailing summary lines) still
      // surface in the warm-cached replay.
      const teePath = teePathFor(deps.logger, event.stepName)
      if (teePath !== null && controller !== undefined) {
        void controller
          .unregisterSource({ type: 'live', stepName: event.stepName })
          .catch(handleSendError)
      }
      deps.tee.close(event.stepName)
      return
    }
    if (event.type === 'step:failed') {
      // tee.write the failure summary FIRST so the bytes land in the file
      // (and therefore in the hidden pane that's still tailing it) before
      // the live → replay transform freezes the source for warm replay.
      if (!torndown) {
        const summary = summarizeFailure({
          stepName: event.stepName,
          runId: deps.runId,
          error: event.error,
          failedAt: deps.clock.now(),
        })
        deps.tee.write(event.stepName, renderFailurePanePayload(summary))
      }
      const teePath = teePathFor(deps.logger, event.stepName)
      if (teePath !== null && controller !== undefined) {
        void controller
          .unregisterSource({ type: 'live', stepName: event.stepName })
          .catch(handleSendError)
      }
      deps.tee.close(event.stepName)
      // Error banner is the durable, unconditional signal that something
      // went wrong — even if the user is on a replay or rollup view. The
      // info `step X complete` banner from `transformLiveToReplay` (when
      // the user was watching this live source) is overwritten by this
      // error via last-write-wins.
      void controller
        ?.emitBanner({ kind: 'error', text: `step ${event.stepName} failed` })
        .catch(handleSendError)
      return
    }
    if (event.type === 'step:parallel-start') {
      // U7: open the `_rollup` meta tee and register a rollup source on the
      // scratch session. The hidden pane tails the tee via `tail -F`; the
      // controller auto-swaps to it when the user is in live mode, or emits
      // an info banner when they're on a replay.
      deps.tee.open(ROLLUP_STEP_NAME)
      const teePath = teePathFor(deps.logger, ROLLUP_STEP_NAME)
      if (teePath !== null && controller !== undefined) {
        void controller
          .registerSource({ type: 'rollup' }, { kind: 'file-tail', path: teePath })
          .catch(handleSendError)
      }
      return
    }
    if (event.type === 'step:parallel-branch-update') {
      // U7: rollup snapshot writes to the `_rollup` tee; the hidden pane's
      // `tail -F` mirrors it into the visible right pane when the rollup
      // source is current. The legacy direct `sendKeys` on the right pane is
      // gone — the rollup lives on its own swap-able pane.
      const snapshot = rollup.apply({
        stepName: event.stepName,
        branchStatus: event.branchStatus,
        ...(event.elapsedMs !== undefined ? { elapsedMs: event.elapsedMs } : {}),
        ...(event.toolCount !== undefined ? { toolCount: event.toolCount } : {}),
      })
      deps.tee.write(ROLLUP_STEP_NAME, renderRollupPayload(snapshot))
      return
    }
    if (event.type === 'step:parallel-complete') {
      // U7: unregister BEFORE closing the tee (the hidden pane is killed by
      // unregisterSource, so there's no consumer reading the trailing bytes
      // after we close) and reset the aggregator so a subsequent parallel
      // block starts with a fresh snapshot.
      if (controller !== undefined) {
        void controller.unregisterSource({ type: 'rollup' }).catch(handleSendError)
      }
      deps.tee.close(ROLLUP_STEP_NAME)
      rollup.reset()
      return
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

    // Left-pane spawns (the steps-view daemon) stay on the legacy respawnPane
    // path: the left pane is owned by the steps-view child, never by the
    // pane-map controller. The daemon's lifecycle is bookended by the
    // caller's PaneQueue takeover message on exit, not by a placeholder
    // restore — and the controller's `interactive` source kind would kill
    // the hidden pane on unregister, which is wrong for the daemon path.
    if (paneRole === 'left') {
      const targetPane = deps.leftPaneId
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
      try {
        await deps.tmux.waitFor({
          socket: deps.socket,
          channel: `pane-exit-${targetPane}`,
        })
      } catch {
        /* left-pane wait failure is non-fatal — the daemon caller handles
           pane takeover on its own. */
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
    // registerSource spawns a hidden pane in the scratch session with the
    // runner argv + env + cwd; the pane is a real PTY (isTTY === true) so
    // arrow keys / Ctrl-C / resize reflow / color all work natively.
    await controller.registerSource(sourceKey, {
      kind: 'pty',
      argv: spawn.argv,
      env: spawn.env,
      cwd: spawn.cwd,
    })
    const hiddenPaneId = controller.getPaneId(sourceKey)
    if (hiddenPaneId === undefined) {
      // Should never happen — registerSource just succeeded. Defensive
      // throw rather than silently waiting on a stale visible-pane id.
      throw new Error(
        `tmux-host.runInteractive: controller.getPaneId returned undefined immediately after registerSource for ${spawn.stepName}`,
      )
    }
    // Swap visible ↔ hidden so the interactive pane is what the user sees.
    await controller.showSource(sourceKey)
    try {
      // Wait on the HIDDEN pane id's pane-died hook. The global hook
      // installed by `initOrchSession` fires for any pane death on the
      // server (cross-session OK), so `pane-exit-<hiddenPaneId>` resolves
      // when the runner exits even though the pane lives in the scratch
      // session.
      await deps.tmux.waitFor({
        socket: deps.socket,
        channel: `pane-exit-${hiddenPaneId}`,
      })
    } finally {
      // unregisterSource for `interactive` kills the hidden pane and (if
      // the interactive source was current) swaps the placeholder back to
      // the visible slot. The old post-exit `respawnPane(['cat'])` restore
      // is gone — the visible right pane never ran the runner argv
      // directly, so there's nothing on it to clean up.
      await controller.unregisterSource(sourceKey).catch(handleSendError)
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
    // Kill the scratch session BEFORE the visible session so the hidden
    // panes that host file-tail / pty sources can't outlive their swap
    // target. `teardownScratchSession` is idempotent and tolerates "session
    // not found" (matches the main killSession's contract).
    try {
      await teardownScratchSession(deps.tmux, deps.scratchSession)
    } catch (err) {
      deps.stderr.write(`[orch tmux] scratch kill-session failed: ${String(err)}\n`)
    }
    void deps.logger?.append('lifecycle', { type: 'scratch-session-torndown' }).catch(() => {})
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

  // Inner stub: `wrapHostWithStepsView` always replaces this with a real
  // implementation that races the quit + attach signals. Kept as a stub so
  // the inner Host satisfies the port type even when constructed in
  // isolation (e.g. exhaustive type-checks on every Host return shape).
  const awaitForegroundShutdown = async (): Promise<void> => {
    /* overridden by wrapHostWithStepsView */
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
    teardown,
  }
}
