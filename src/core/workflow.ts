import { randomUUID } from 'node:crypto'
import type { Host } from '../hosts/index.ts'
import type { JsonObject, SessionLogger, StepSpan } from '../observability/index.ts'
import { envKeys as envKeyList, orchLog, redactReproduceCommand } from '../observability/index.ts'
// Capture lock is a workflow-execution primitive (not a runner adapter), used by
// `runInteractiveStep` to serialize concurrent `captureSessionId` calls that
// share the same backing filesystem. Imported from the Codex folder for now
// since Codex is the only consumer; promote to `src/services/` if a second
// runner ever needs it.
import { createCaptureLock } from '../runners/codex/capture-lock.ts'
import { runRunner } from '../runners/index.ts'
import type { CaptureError, CaptureLock } from '../runners/types.ts'
import type { Clock, FsService, GitService, ProcessService } from '../services/index.ts'
import { GitCommandError } from '../services/index.ts'
import type { PromptService } from '../services/prompt/index.ts'
import type { StateStore, StepEntry, TranscriptSidecar } from '../state/index.ts'
import {
  anyNeedsHeadSha,
  normalizeValidators,
  ValidationError,
  type ValidatorCtx,
  type ValidatorServices,
} from '../validators/index.ts'
import { isAskCacheValid, runAskStep } from './ask-executor.ts'
import { runCommandStep } from './command.ts'
import {
  InteractiveParallelError,
  ResumeError,
  RunNotFoundError,
  RunnerCapabilityError,
  StepError,
} from './errors.ts'
import { currentCwd, currentParallelDepth, executionContext } from './execution-context.ts'
import type { ResumeRegistry } from './resume-registry.ts'
import { resolveView } from './view-registry.ts'

// Re-export so existing imports from './workflow.ts' remain valid.
export { InteractiveParallelError, ResumeError, RunNotFoundError, RunnerCapabilityError, StepError }

import { ParallelError } from './parallel.ts'
import { SchemaValidationError } from './schema.ts'
import { type AgentStepConfig, type CommitStepConfig, onCacheHit, type Step } from './step.ts'
import {
  type InteractiveResult,
  type Path,
  type RunId,
  type StepMode,
  type StepName,
  stepName,
} from './types.ts'
import { outcomesToFailures, outcomesToPersisted, runValidators } from './validation-runner.ts'
import { runWorktreeStep } from './worktree.ts'

// ---------------------------------------------------------------------------
// JsonValue — compile-time serialization safety for extraContext
// ---------------------------------------------------------------------------

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }

// ---------------------------------------------------------------------------
// WorkflowArgs — CLI-supplied arguments handed to the workflow callback.
// ---------------------------------------------------------------------------
// Only `prompt` is reserved today. Callers use `args.prompt !== undefined`
// for presence checks — an empty string is a valid, distinct value.
export interface WorkflowArgs {
  readonly prompt?: string
}

// ---------------------------------------------------------------------------
// RunOverrides — per-call overrides for run()
// ---------------------------------------------------------------------------

export interface RunOverrides {
  readonly as?: string
  readonly prompt?: string
  readonly extraContext?: JsonValue
  readonly extraPrompt?: string
  readonly mode?: StepMode
}

// ---------------------------------------------------------------------------
// StepLifecycleEvent — fans out through `host.onLifecycleEvent` for every
// observer (status rollup, plain-host line printer, future plugins).
// ---------------------------------------------------------------------------

/**
 * Per-branch status updates for the Story 3 parallel rollup. Emitted by the
 * executor as a *supplement* to `step:start`/`step:complete`/`step:failed`
 * whenever a step runs inside a `parallel()` call — hosts that know how to
 * render a compact rollup (two-pane) consume them; hosts that don't (plain)
 * can safely ignore them because the step:* events already carry the full
 * lifecycle.
 *
 * Limitation: `parallel([run(A), run(B)])` (heterogeneous form) starts each
 * branch promise before `parallel()` takes over, so `currentParallelDepth()`
 * is 0 inside those branches and this event does NOT fire. The homogeneous
 * form `parallel(items, fn)` wraps each call in an AsyncLocalStorage context
 * and works as designed.
 */
export type ParallelBranchStatus = 'running' | 'completed' | 'failed' | 'cancelled'

export type StepLifecycleEvent =
  | { readonly type: 'step:start'; readonly stepName: StepName; readonly mode: StepMode }
  | { readonly type: 'step:complete'; readonly stepName: StepName; readonly durationMs: number }
  | { readonly type: 'step:failed'; readonly stepName: StepName; readonly error: unknown }
  | { readonly type: 'step:cached'; readonly stepName: StepName }
  | {
      readonly type: 'step:parallel-branch-update'
      readonly stepName: StepName
      readonly branchStatus: ParallelBranchStatus
      /** ms since the branch started — `undefined` on the first running event. */
      readonly elapsedMs?: number
      /**
       * Best-effort count of tool invocations observed so far. `undefined`
       * when the executor cannot determine it (e.g. before the runner wires
       * tool tracking — v2 concern). Hosts treat `undefined` as "unknown".
       */
      readonly toolCount?: number
    }
  | {
      /** Fired once at the top of a `parallel(...)` call before any branch's
       *  `step:start`. Carries a deterministic `blockId` so hosts can correlate
       *  start with complete (e.g. nested or sequential parallel blocks). */
      readonly type: 'step:parallel-start'
      readonly blockId: number
    }
  | {
      /** Fired once after all branches in a `parallel(...)` call settle
       *  (regardless of pass/fail). The block id matches the corresponding
       *  `step:parallel-start`. */
      readonly type: 'step:parallel-complete'
      readonly blockId: number
    }

// ---------------------------------------------------------------------------
// InteractiveContext — passed to onInteractive handler
// ---------------------------------------------------------------------------

export interface InteractiveContext {
  readonly stepName: StepName
  readonly prompt: string
  readonly sessionId: string
  readonly runner: import('../runners/index.ts').Runner
}

// ---------------------------------------------------------------------------
// WorkflowDeps — everything the executor needs
// ---------------------------------------------------------------------------

export interface WorkflowDeps {
  readonly stateStore: StateStore
  readonly processService: ProcessService
  readonly clock: Clock
  readonly runId: RunId
  readonly cwd: Path
  readonly fsService: FsService
  readonly gitService: GitService
  readonly workflowName?: string
  /**
   * Sole observability seam. Lifecycle events and runner events fan out
   * through this port; the CLI chooses the implementation (`PlainHost` for
   * `--mode=plain`, `TmuxHost` for `two-pane` once Phase D lands).
   */
  readonly host: Host
  /**
   * Writes autonomous steps' RunnerEvents to append-only NDJSON sidecars
   * under `.orch/state/<runId>/logs/agents/<step>/events.ndjson`. The
   * `StepEntry` carries only a relative path + event count; `orch logs`
   * streams the sidecar. Absent in tests that don't care about persistence.
   */
  readonly transcriptSidecar?: TranscriptSidecar
  /** Agent-native hook: decouples interactive from TTY. */
  readonly onInteractive?: (ctx: InteractiveContext) => Promise<InteractiveResult>
  /** Injectable session ID generator. Defaults to crypto.randomUUID(). */
  readonly generateSessionId?: () => string
  /** CLI-supplied arguments. When omitted, the workflow callback sees `{}`. */
  readonly args?: WorkflowArgs
  /**
   * Optional per-run session logger. When present, the executor fans out
   * spawn records, runner events, step lifecycle, and per-step session.json
   * snapshots into `.orch/state/<runId>/logs/`. Absent in tests that don't
   * care about logs (null adapter is the zero-cost default in the CLI path).
   */
  readonly logger?: SessionLogger
  /**
   * Renders interactive prompts for `ask()` steps; supplied by the host
   * wiring at the composition root. The plain CLI path uses
   * `ReadlinePromptService`; tests wire `FakePromptService`. Required —
   * absent → ask() steps cannot run.
   */
  readonly promptService: PromptService
  /**
   * Run-level interactivity axis (orthogonal to RunMode).
   *
   *  - 'interactive' (default): ask() renders normally.
   *  - 'noninteractive': ask() resolves from `defaultWhenNoninteractive`,
   *    or throws `AskNoDefaultError` if none declared.
   *
   * Sourced from the CLI flag (`--interactive` / `--noninteractive`) or the
   * `ORCH_NONINTERACTIVE=1` env var per invocation. NOT persisted to
   * RunState — resume reads whatever the resumer passes.
   */
  readonly interactivity: 'interactive' | 'noninteractive'
  /**
   * Live, step-keyed runner registry shared with the host stack. Populated by
   * `runStepOnce` at the start of every interactive agent step (including
   * cache-hit replays on `orch resume`). The right-pane controller derefs it
   * on every Enter press to drive `runner.resumeCommand`. Optional —
   * intentionally omitted in tests that exercise the legacy "no runner wired"
   * refusal path.
   */
  readonly resumeRegistry?: ResumeRegistry
}

// ---------------------------------------------------------------------------
// WorkflowFn — the function a workflow author writes. `args` is optional
// in the signature so legacy `async (run) => ...` callbacks still compile.
// ---------------------------------------------------------------------------

export type WorkflowFn = (run: RunFn, args: WorkflowArgs) => Promise<void>

// ---------------------------------------------------------------------------
// RunFn — the signature of the `run` closure passed to workflow functions
// ---------------------------------------------------------------------------

/** Override with `mode: 'interactive'` always yields InteractiveResult. */
export interface RunFn {
  <T>(
    step: Step<T>,
    overrides: RunOverrides & { readonly mode: 'interactive' },
  ): Promise<InteractiveResult>
  <T>(step: Step<T>, overrides?: RunOverrides): Promise<T>
}

// ---------------------------------------------------------------------------
// WorkflowExecutor — returned by workflow()
// ---------------------------------------------------------------------------

export interface WorkflowExecutor {
  readonly name: string
  execute(deps: WorkflowDeps): Promise<void>
  /** Resume a crashed or stuck run. Accepts 'crashed' or 'running' status.
   *  Throws RunNotFoundError if the run does not exist.
   *  Throws ResumeError if the run is already completed.
   *  Single-process only — no cross-process locking. */
  resume(deps: WorkflowDeps): Promise<void>
}

// ---------------------------------------------------------------------------
// assemblePrompt — builds the final prompt from defaults and overrides
// ---------------------------------------------------------------------------

function assemblePrompt(
  defaultPrompt: string | undefined,
  overrides: RunOverrides | undefined,
): string {
  const base = overrides?.prompt ?? defaultPrompt ?? ''
  const parts = [base]
  if (overrides?.extraContext !== undefined) {
    parts.push(JSON.stringify(overrides.extraContext, null, 2))
  }
  if (overrides?.extraPrompt) parts.push(overrides.extraPrompt)
  return parts.filter(Boolean).join('\n\n')
}

// ---------------------------------------------------------------------------
// resolveMode — override > config > autonomous
// ---------------------------------------------------------------------------

function resolveMode(config: AgentStepConfig, overrides: RunOverrides | undefined): StepMode {
  return overrides?.mode ?? config.mode ?? 'autonomous'
}

// ---------------------------------------------------------------------------
// safeHeadSha — best-effort baseline capture
// ---------------------------------------------------------------------------

async function safeHeadSha(git: GitService, cwd: Path): Promise<string | undefined> {
  try {
    return await git.headSha(cwd)
  } catch (err) {
    if (err instanceof GitCommandError) return undefined
    throw err
  }
}

// ---------------------------------------------------------------------------
// Schema helpers — extracted for cognitive complexity budget
// ---------------------------------------------------------------------------

function checkSchemaCapability(config: AgentStepConfig, key: StepName): void {
  if (config.returns !== undefined && !config.agent.supports.structuredOutput) {
    throw new Error(
      `Runner "${config.agent.name}" does not support structured output; ` +
        `remove "returns:" from step "${key}" or use a runner that supports it`,
    )
  }
}

function validateSchemaOutput(config: AgentStepConfig, key: StepName, rawValue: unknown): unknown {
  if (config.returns === undefined) return rawValue

  if (rawValue === undefined) {
    throw new Error(
      `Step "${key}": runner "${config.agent.name}" returned no structured_output ` +
        'despite --json-schema being set. Check CLI version and flag compatibility.',
    )
  }
  const parseResult = config.returns.zodSchema.safeParse(rawValue)
  if (!parseResult.success) throw new SchemaValidationError(key, parseResult.error)
  return parseResult.data
}

// ---------------------------------------------------------------------------
// Lifecycle tee — fans step events through the host AND the session logger.
// Host owns rendering; logger owns the structured trace. Single call site
// keeps the two observers in lock-step — see plan § "Host-side vs executor-
// side lifecycle".
// ---------------------------------------------------------------------------

// Step-scoped subset of `StepLifecycleEvent` — all variants that carry a
// `stepName`. The block-scoped events (`step:parallel-start` /
// `step:parallel-complete`) are emitted by `parallel()` directly and never
// reach this helper.
type StepScopedLifecycleEvent = Extract<StepLifecycleEvent, { stepName: StepName }>

function emitStepLifecycle(
  host: Host,
  stepSpan: StepSpan | undefined,
  event: StepScopedLifecycleEvent,
): void {
  host.onLifecycleEvent(event)
  if (stepSpan === undefined) return
  const { type, stepName: _name, ...rest } = event
  void stepSpan.append('lifecycle', { type, ...(rest as JsonObject) }).catch(() => {})
}

// ---------------------------------------------------------------------------
// Reproduce command — `cd <cwd> && KEY=v ... <argv>` with secret redaction.
// Values are omitted by default (envKeys-only); the string is already passed
// through `redactReproduceCommand` so any caller-side env emission stays safe.
// ---------------------------------------------------------------------------

function buildReproduce(
  cwd: Path,
  env: Readonly<Record<string, string>>,
  argv: readonly string[],
): string {
  const envParts = Object.keys(env)
    .sort()
    .map((k) => `${k}=${shellQuote(env[k] ?? '')}`)
  const quotedArgv = argv.map((a) => shellQuote(a)).join(' ')
  const envPrefix = envParts.length > 0 ? `${envParts.join(' ')} ` : ''
  return redactReproduceCommand(`cd ${shellQuote(cwd)} && ${envPrefix}${quotedArgv}`)
}

function shellQuote(s: string): string {
  if (s === '') return "''"
  if (/^[A-Za-z0-9_\-./=:]+$/.test(s)) return s
  return `'${s.replace(/'/g, `'\\''`)}'`
}

// ---------------------------------------------------------------------------
// runInteractiveStep — executes an interactive step via foreground spawn
// ---------------------------------------------------------------------------

async function runInteractiveStep(
  deps: WorkflowDeps,
  captureLock: CaptureLock,
  config: AgentStepConfig,
  key: StepName,
  overrides: RunOverrides | undefined,
  stepSpan: StepSpan | undefined,
): Promise<{ value: InteractiveResult; entry: StepEntry }> {
  // Guard: interactive inside parallel()
  if (currentParallelDepth() > 0) {
    throw new InteractiveParallelError(key)
  }

  // Guard: runner capability
  if (!config.agent.supports.interactive) {
    throw new RunnerCapabilityError(key, config.agent.name)
  }

  // View resolution surfaces the "interactive step under --mode=plain" error
  // before we try to spawn a foreground process. Skipped when an
  // `onInteractive` handler is wired — that path is agent-native and owns
  // rendering externally.
  if (deps.onInteractive === undefined) {
    resolveView({
      stepConfig: config,
      runner: config.agent,
      runMode: deps.host.mode,
      stepName: key,
      stepMode: 'interactive',
    })
  }

  const orchSessionId = deps.generateSessionId?.() ?? randomUUID()
  const prompt = assemblePrompt(config.prompt, overrides)
  const startedAtStep = deps.clock.now()
  const cwd = currentCwd(deps.cwd)

  emitStepLifecycle(deps.host, stepSpan, {
    type: 'step:start',
    stepName: key,
    mode: 'interactive',
  })
  const inParallel = currentParallelDepth() > 0
  if (inParallel) {
    emitStepLifecycle(deps.host, stepSpan, {
      type: 'step:parallel-branch-update',
      stepName: key,
      branchStatus: 'running',
    })
  }

  // If an onInteractive handler is provided, delegate to it (agent-native).
  // Otherwise, require a TTY and do foreground spawn.
  // Runners that mint their own session id post-spawn (Codex's thread_id)
  // declare `captureSessionId`; we kick capture off BEFORE spawning so the
  // snapshot of `~/.codex/sessions/` is taken before Codex writes its rollout
  // file. Runners that pre-set the id (Claude via --session-id) skip this
  // branch and keep the orch-generated UUID end-to-end.
  let exitCode: number
  let durationMs: number
  let argv: readonly string[] = []
  let cmdEnv: Readonly<Record<string, string>> = {}
  let persistedSessionId: string = orchSessionId
  let sessionIdCaptureError: CaptureError | undefined

  if (deps.onInteractive) {
    const result = await deps.onInteractive({
      stepName: key,
      prompt,
      sessionId: orchSessionId,
      runner: config.agent,
    })
    exitCode = result.exitCode
    durationMs = result.durationMs
  } else {
    // Plain host requires a TTY (inherits stdio); tmux host takes the pane
    // over via respawn-pane, so the parent-process TTY is irrelevant there.
    if (
      deps.host.mode === 'plain' &&
      typeof process !== 'undefined' &&
      process.stdin &&
      !process.stdin.isTTY
    ) {
      throw new Error(`Interactive step "${key}" requires a TTY or an onInteractive handler`)
    }

    const captureFn = config.agent.captureSessionId
    // Start the capture window before spawning so the helper's initial
    // snapshot of the sessions directory excludes the rollout file Codex is
    // about to write. The ordering invariant lives in `await snapshotReady`.
    const captureHandle =
      typeof captureFn === 'function'
        ? captureFn({
            cwd,
            fs: deps.fsService,
            clock: deps.clock,
            lock: captureLock,
          })
        : undefined

    if (captureHandle !== undefined) {
      await captureHandle.snapshotReady
    }

    const cmd = await config.agent.buildCommand({
      cwd,
      env: {},
      prompt,
      extraArgs: [],
      mode: 'interactive',
      sessionId: orchSessionId,
    })
    argv = cmd.argv
    cmdEnv = cmd.env
    const interactivePromise = deps.host.runInteractive({
      argv: cmd.argv,
      env: cmd.env,
      cwd,
      stepName: key,
    })

    const result = await interactivePromise
    exitCode = result.exitCode
    durationMs = result.durationMs

    if (captureHandle !== undefined) {
      // Capture either resolved earlier (rollout file landed within the poll
      // window) or is now bounded by the helper's `timeoutMs`. Awaiting here
      // never extends the user-visible interactive session.
      const captureResult = await captureHandle.result
      if ('sessionId' in captureResult) {
        persistedSessionId = captureResult.sessionId
      } else {
        sessionIdCaptureError = captureResult.error
      }
    }
  }

  logInteractiveSpawn(stepSpan, {
    runnerName: config.agent.name,
    argv,
    cmdEnv,
    cwd,
    sessionId: persistedSessionId,
    exitCode,
    durationMs,
  })

  if (exitCode !== 0) {
    emitStepFailure(deps.host, stepSpan, key, `exit ${exitCode}`, inParallel, durationMs)
    throw new StepError(key, exitCode, `interactive session exited ${exitCode}`)
  }

  // InteractiveResult.sessionId must always be a string (Zod requires UUID
  // shape). On capture failure we surface the orch-generated UUID to keep the
  // value schema honest — the top-level `entry.sessionId` is what drives
  // resume and IS omitted via the conditional below.
  const value: InteractiveResult = { exitCode, durationMs, sessionId: persistedSessionId }

  emitStepSuccess(deps.host, stepSpan, key, inParallel, durationMs)

  const hasResumeSupport = typeof config.agent.resumeCommand === 'function'
  const persistsSessionId = hasResumeSupport && sessionIdCaptureError === undefined

  const entry: StepEntry = {
    name: key,
    value,
    startedAt: startedAtStep,
    endedAt: deps.clock.now(),
    artifacts: [],
    validations: [],
    mode: 'interactive',
    transcriptEventCount: 0,
    transcriptTruncated: false,
    // Top-level sessionId for the right-pane controller's resume dispatch.
    // Omitted when the runner has no resume primitive OR when post-spawn
    // capture failed for a runner that mints its own id — the right-pane
    // refusal text (U9) names the cause via `sessionIdCaptureError`.
    ...(persistsSessionId ? { sessionId: persistedSessionId } : {}),
    // History-resume: diagnostic label so a past step's refusal can name the
    // runner (R8 vs R11 disambiguation in the right-pane controller). Lookup
    // of the live runner still goes through `ResumeRegistry`, not this name.
    runnerName: config.agent.name,
    ...(sessionIdCaptureError !== undefined ? { sessionIdCaptureError } : {}),
  }

  await writeInteractiveSession(deps.logger, stepSpan, {
    stepName: key,
    runnerName: config.agent.name,
    prompt,
    argv,
    cmdEnv,
    cwd,
    sessionId: persistedSessionId,
    exitCode,
    durationMs,
  })

  return { value, entry }
}

// ---------------------------------------------------------------------------
// Step lifecycle emitters — keep runAgentStep / runInteractiveStep terse.
// ---------------------------------------------------------------------------

function emitStepFailure(
  host: Host,
  stepSpan: StepSpan | undefined,
  key: StepName,
  error: unknown,
  inParallel: boolean,
  durationMs: number,
): void {
  emitStepLifecycle(host, stepSpan, { type: 'step:failed', stepName: key, error })
  if (inParallel) {
    emitStepLifecycle(host, stepSpan, {
      type: 'step:parallel-branch-update',
      stepName: key,
      branchStatus: 'failed',
      elapsedMs: durationMs,
    })
  }
}

function emitStepSuccess(
  host: Host,
  stepSpan: StepSpan | undefined,
  key: StepName,
  inParallel: boolean,
  durationMs: number,
): void {
  emitStepLifecycle(host, stepSpan, { type: 'step:complete', stepName: key, durationMs })
  if (inParallel) {
    emitStepLifecycle(host, stepSpan, {
      type: 'step:parallel-branch-update',
      stepName: key,
      branchStatus: 'completed',
      elapsedMs: durationMs,
    })
  }
}

interface InteractiveSpawnRecord {
  readonly runnerName: string
  readonly argv: readonly string[]
  readonly cmdEnv: Readonly<Record<string, string>>
  readonly cwd: Path
  readonly sessionId: string
  readonly exitCode: number
  readonly durationMs: number
}

function logInteractiveSpawn(stepSpan: StepSpan | undefined, r: InteractiveSpawnRecord): void {
  if (stepSpan === undefined) return
  void stepSpan
    .append('spawns', {
      runnerName: r.runnerName,
      mode: 'interactive',
      argv: r.argv,
      envKeys: envKeyList(r.cmdEnv),
      cwd: r.cwd,
      sessionId: r.sessionId,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      reproduce: buildReproduce(r.cwd, r.cmdEnv, r.argv),
    })
    .catch(() => {})
}

async function writeInteractiveSession(
  logger: SessionLogger | undefined,
  stepSpan: StepSpan | undefined,
  r: InteractiveSpawnRecord & { readonly stepName: StepName; readonly prompt: string },
): Promise<void> {
  if (logger === undefined || stepSpan === undefined) return
  const body = JSON.stringify(
    {
      stepName: r.stepName,
      stepSpanId: stepSpan.stepSpanId,
      runnerName: r.runnerName,
      mode: 'interactive',
      // Interactive steps only ever produce session.json — tmux owns the PTY
      // and orch never sees the bytes. The map is empty so cold readers don't
      // chase ghosts.
      outputs: {},
      prompt: r.prompt,
      argv: r.argv,
      envKeys: envKeyList(r.cmdEnv),
      sessionId: r.sessionId,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
    },
    null,
    2,
  )
  await logger.writeFile(`agents/${r.stepName}/session.json`, body).catch(() => {})
}

// ---------------------------------------------------------------------------
// openRawCapture — opens always-on raw stdout/stderr sinks for an agent step.
// Returns undefined only when there's no logger so the runner deps stay free
// of the `onRawLine` hook on test paths that pass no logger. On step end, the
// caller awaits `close()` to flush pending appends to disk.
// ---------------------------------------------------------------------------

interface RawCapture {
  readonly onRawLine: (stream: 'stdout' | 'stderr', line: string) => void
  close(): Promise<void>
}

function openRawCapture(logger: SessionLogger | undefined, key: StepName): RawCapture | undefined {
  if (logger === undefined) return undefined
  // `truncateOnOpen` so a resumed step's folder reflects only the latest
  // attempt — same contract the transcript sidecar and per-step render tee
  // observe.
  const stdoutSink = logger.streamSink(`agents/${key}/raw_output.ndjson`, { truncateOnOpen: true })
  const stderrSink = logger.streamSink(`agents/${key}/raw_stderr.log`, { truncateOnOpen: true })
  return {
    onRawLine(stream, line) {
      const sink = stream === 'stdout' ? stdoutSink : stderrSink
      void sink.write(`${line}\n`).catch(() => {})
    },
    async close() {
      await Promise.all([stdoutSink.close(), stderrSink.close()])
    },
  }
}

// ---------------------------------------------------------------------------
// runAgentStep — executes an autonomous step via a Runner adapter
// ---------------------------------------------------------------------------

function makeAgentEventHandler(
  deps: WorkflowDeps,
  key: StepName,
  runner: import('../runners/index.ts').Runner,
  stepTranscript: ReturnType<NonNullable<WorkflowDeps['transcriptSidecar']>['forStep']> | undefined,
  stepSpan: StepSpan | undefined,
  isSilent: boolean,
): (evt: import('../runners/index.ts').RunnerEvent) => void {
  return (evt) => {
    if (stepTranscript !== undefined) {
      // Fire-and-forget: events arrive synchronously; the append is awaited
      // on the background chain inside the sidecar so ordering stays stable.
      void stepTranscript.append(evt).catch(() => {})
    }
    if (stepSpan !== undefined) {
      void stepSpan.append('events', { event: evt }).catch(() => {})
    }
    if (isSilent) return
    const lines = safeToTranscriptLines(runner, evt, deps.logger, key)
    deps.host.onRunnerEvent(evt, key, lines)
  }
}

// A buggy formatter must not abort a run. We catch, log once per call, and
// pass an empty `lines` array to the host. The raw event still flows to
// `transcript.ndjson` and to the host's JSON path unmodified.
function safeToTranscriptLines(
  runner: import('../runners/index.ts').Runner,
  evt: import('../runners/index.ts').RunnerEvent,
  logger: SessionLogger | undefined,
  stepName: StepName,
): readonly import('../runners/index.ts').TranscriptLine[] {
  try {
    return runner.toTranscriptLines(evt)
  } catch (err) {
    orchLog(logger, 'transcript-format-error', {
      stepName,
      runner: runner.name,
      eventKind: evt.kind,
      eventType: evt.type,
      error: err instanceof Error ? err.message : String(err),
    })
    return []
  }
}

async function runAgentStep(
  deps: WorkflowDeps,
  config: AgentStepConfig,
  key: StepName,
  overrides: RunOverrides | undefined,
  stepSpan: StepSpan | undefined,
): Promise<{ value: unknown; entry: StepEntry }> {
  checkSchemaCapability(config, key)

  // Resolve the step's view early so we know whether to pipe RunnerEvents
  // through the host. `silent: true` short-circuits the pipe (the step still
  // runs and emits lifecycle events); non-silent still flows into the host.
  const resolution = resolveView({
    stepConfig: config,
    runner: config.agent,
    runMode: deps.host.mode,
    stepName: key,
    stepMode: 'autonomous',
  })
  const isSilent = resolution.kind === 'silent'
  orchLog(deps.logger, 'resolveView', {
    stepName: key,
    kind: resolution.kind,
    ...(resolution.kind !== 'silent' ? { pane: resolution.pane } : {}),
  })
  const inParallel = currentParallelDepth() > 0

  emitStepLifecycle(deps.host, stepSpan, {
    type: 'step:start',
    stepName: key,
    mode: 'autonomous',
  })
  if (inParallel) {
    emitStepLifecycle(deps.host, stepSpan, {
      type: 'step:parallel-branch-update',
      stepName: key,
      branchStatus: 'running',
    })
  }

  const cwd = currentCwd(deps.cwd)
  const normalized = normalizeValidators(config.validate, key)
  const headSha = anyNeedsHeadSha(normalized) ? await safeHeadSha(deps.gitService, cwd) : undefined
  const preRunSnapshot = headSha !== undefined ? { headSha } : undefined

  const startedAt = deps.clock.now()
  const prompt = assemblePrompt(config.prompt, overrides)
  // Sidecar captures every RunnerEvent (silent steps included — `orch logs`
  // needs the trace even when the host renders nothing). Errors are logged
  // to stderr but do not abort the step; transcript loss is recoverable,
  // a step failure from a fs hiccup is not.
  const stepTranscript = deps.transcriptSidecar?.forStep(key)
  const rawCapture = openRawCapture(deps.logger, key)
  const runnerDeps = {
    processService: deps.processService,
    clock: deps.clock,
    onEvent: makeAgentEventHandler(deps, key, config.agent, stepTranscript, stepSpan, isSilent),
    ...(rawCapture !== undefined ? { onRawLine: rawCapture.onRawLine } : {}),
  }
  // Build the runner command up front so spawn records capture argv/env even
  // when the runner fails mid-run. Agents that error before exec still land a
  // spawn entry with the argv the executor would have used.
  const runnerCtx = {
    cwd,
    env: {},
    prompt,
    extraArgs: [],
    ...(config.returns !== undefined ? { schema: { jsonSchema: config.returns.jsonSchema } } : {}),
  }
  let result: Awaited<ReturnType<typeof runRunner>>
  try {
    result = await runRunner(config.agent, runnerCtx, runnerDeps)
  } finally {
    await rawCapture?.close().catch(() => {})
  }
  const durationMs = deps.clock.now() - startedAt

  await logAgentSpawn(stepSpan, config, runnerCtx, {
    cwd,
    exitCode: result.exitCode,
    durationMs,
  })

  if (result.finalEvent.type === 'error' || result.exitCode !== 0) {
    const msg =
      result.finalEvent.type === 'error'
        ? result.finalEvent.message
        : `runner exited ${result.exitCode}`
    emitStepFailure(deps.host, stepSpan, key, msg, inParallel, durationMs)
    throw new StepError(key, result.exitCode, msg)
  }

  const rawValue = config.agent.extractStructuredOutput(result.finalEvent)
  const value = validateSchemaOutput(config, key, rawValue)

  const validatorCtx: ValidatorCtx = {
    stepName: key,
    cwd,
    value,
    ...(preRunSnapshot !== undefined ? { preRunSnapshot } : {}),
  }
  const services: ValidatorServices = { fs: deps.fsService, git: deps.gitService }
  const outcomes = await runValidators(normalized, services, validatorCtx)
  const failures = outcomesToFailures(outcomes)
  if (failures.length > 0) {
    throw new ValidationError(key, failures)
  }

  emitStepSuccess(deps.host, stepSpan, key, inParallel, durationMs)

  const entry = buildAgentEntry({
    key,
    value,
    startedAt,
    endedAt: deps.clock.now(),
    preRunSnapshot,
    outcomes,
    transcriptMeta: stepTranscript?.snapshot(),
  })

  await writeAgentSession(deps.logger, stepSpan, {
    stepName: key,
    runnerName: config.agent.name,
    prompt,
    config,
    runnerCtx,
    result,
    durationMs,
    transcriptSnapshot: stepTranscript?.snapshot(),
  })

  return { value, entry }
}

async function logAgentSpawn(
  stepSpan: StepSpan | undefined,
  config: AgentStepConfig,
  runnerCtx: import('../runners/index.ts').RunnerContext,
  r: { readonly cwd: Path; readonly exitCode: number; readonly durationMs: number },
): Promise<void> {
  if (stepSpan === undefined) return
  const cmd = await tryBuildCommand(config, runnerCtx)
  void stepSpan
    .append('spawns', {
      runnerName: config.agent.name,
      mode: 'autonomous',
      argv: cmd.argv,
      envKeys: envKeyList(cmd.env),
      cwd: r.cwd,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      reproduce: buildReproduce(r.cwd, cmd.env, cmd.argv),
    })
    .catch(() => {})
}

async function writeAgentSession(
  logger: SessionLogger | undefined,
  stepSpan: StepSpan | undefined,
  r: {
    readonly stepName: StepName
    readonly runnerName: string
    readonly prompt: string
    readonly config: AgentStepConfig
    readonly runnerCtx: import('../runners/index.ts').RunnerContext
    readonly result: Awaited<ReturnType<typeof runRunner>>
    readonly durationMs: number
    readonly transcriptSnapshot:
      | { readonly transcriptPath: string; readonly transcriptEventCount: number }
      | undefined
  },
): Promise<void> {
  if (logger === undefined || stepSpan === undefined) return
  const cmd = await tryBuildCommand(r.config, r.runnerCtx)
  const body = JSON.stringify(
    {
      stepName: r.stepName,
      stepSpanId: stepSpan.stepSpanId,
      runnerName: r.runnerName,
      mode: 'autonomous',
      outputs: AUTONOMOUS_OUTPUTS,
      prompt: r.prompt,
      argv: cmd.argv,
      envKeys: envKeyList(cmd.env),
      finalEvent: r.result.finalEvent,
      exitCode: r.result.exitCode,
      durationMs: r.durationMs,
      ...(r.transcriptSnapshot !== undefined && r.transcriptSnapshot.transcriptEventCount > 0
        ? { transcriptPath: r.transcriptSnapshot.transcriptPath }
        : {}),
    },
    null,
    2,
  )
  await logger.writeFile(`agents/${r.stepName}/session.json`, body).catch(() => {})
}

// `outputs:` map embedded in `session.json` so a cold reader can inventory the
// per-step folder's siblings without prior knowledge. Paths are relative to
// the per-step folder itself (the file containing this map). Interactive steps
// only ever produce `session.json`; autonomous steps produce the full set.
const AUTONOMOUS_OUTPUTS = Object.freeze({
  events: 'events.ndjson',
  rawStdout: 'raw_output.ndjson',
  rawStderr: 'raw_stderr.log',
  formattedAnsi: 'formatted_output.ansi',
  formattedText: 'formatted_output.txt',
})

// Best-effort command rebuild for log-only purposes. Runners whose
// `buildCommand` rejects get empty argv/env — logging must not fail the run.
async function tryBuildCommand(
  config: AgentStepConfig,
  ctx: import('../runners/index.ts').RunnerContext,
): Promise<{ readonly argv: readonly string[]; readonly env: Readonly<Record<string, string>> }> {
  try {
    return await config.agent.buildCommand(ctx)
  } catch {
    return { argv: [], env: {} }
  }
}

function buildAgentEntry(inputs: {
  readonly key: StepName
  readonly value: unknown
  readonly startedAt: number
  readonly endedAt: number
  readonly preRunSnapshot: { readonly headSha: string } | undefined
  readonly outcomes: ReturnType<typeof runValidators> extends Promise<infer T> ? T : never
  readonly transcriptMeta:
    | { readonly transcriptPath: string; readonly transcriptEventCount: number }
    | undefined
}): StepEntry {
  const { transcriptMeta, preRunSnapshot } = inputs
  return {
    name: inputs.key,
    value: inputs.value,
    startedAt: inputs.startedAt,
    endedAt: inputs.endedAt,
    artifacts: [],
    ...(preRunSnapshot !== undefined ? { preRunSnapshot } : {}),
    validations: outcomesToPersisted(inputs.outcomes),
    mode: 'autonomous',
    ...(transcriptMeta !== undefined && transcriptMeta.transcriptEventCount > 0
      ? { transcriptPath: transcriptMeta.transcriptPath }
      : {}),
    transcriptEventCount: transcriptMeta?.transcriptEventCount ?? 0,
    transcriptTruncated: false,
  }
}

// ---------------------------------------------------------------------------
// runCommitStep — executes a commit step via GitService
// ---------------------------------------------------------------------------

async function runCommitStep(
  deps: WorkflowDeps,
  config: CommitStepConfig,
  key: StepName,
  overrides: RunOverrides | undefined,
): Promise<{ value: unknown; entry: StepEntry }> {
  if (overrides?.prompt !== undefined) {
    throw new Error(`Commit step "${key}" does not accept prompt overrides`)
  }
  if (overrides?.extraContext !== undefined) {
    throw new Error(`Commit step "${key}" does not accept extraContext overrides`)
  }
  if (overrides?.extraPrompt !== undefined) {
    throw new Error(`Commit step "${key}" does not accept extraPrompt overrides`)
  }

  const startedAt = deps.clock.now()
  const cwd = currentCwd(deps.cwd)
  const clean = await deps.gitService.isClean(cwd)

  if (clean) {
    const entry: StepEntry = {
      name: key,
      value: null,
      startedAt,
      endedAt: deps.clock.now(),
      artifacts: [],
      validations: [],
      transcriptEventCount: 0,
      transcriptTruncated: false,
    }
    return { value: null, entry }
  }

  await deps.gitService.stageAll(cwd)
  const sha = await deps.gitService.commit(cwd, config.message)
  const value = { sha }

  const entry: StepEntry = {
    name: key,
    value,
    startedAt,
    endedAt: deps.clock.now(),
    artifacts: [],
    validations: [],
    transcriptEventCount: 0,
    transcriptTruncated: false,
  }
  return { value, entry }
}

// ---------------------------------------------------------------------------
// runStepOnce — thin dispatcher with exhaustive switch
// ---------------------------------------------------------------------------

async function runStepOnce(
  deps: WorkflowDeps,
  captureLock: CaptureLock,
  s: Step,
  overrides: RunOverrides | undefined,
): Promise<unknown> {
  const key = stepName(overrides?.as ?? s.name)

  // Register the runner for resume lookup before any short-circuit. Cache hits
  // on `orch resume` populate the registry progressively so the right pane
  // can resolve a past interactive step the moment the executor reaches it.
  // Restricted to the interactive branch — autonomous steps are out of scope
  // for the history-resume feature (origin F8).
  if (s.config.kind === 'agent' && resolveMode(s.config, overrides) === 'interactive') {
    deps.resumeRegistry?.register(key, s.config.agent)
  }

  const state = await deps.stateStore.loadRun(deps.runId)
  const cached = state?.steps[key]
  if (cached !== undefined) {
    // Ask cache may be stale if the step's buttons or field keys changed
    // between runs. Predicate-based detection (NOT a thrown sentinel): when
    // invalid, we log a one-liner and fall through to the normal execution
    // path, which atomically replaces the stale entry. Cancelled cache stays
    // valid across button/field changes — cancel doesn't depend on shape.
    if (s.config.kind === 'ask' && !isAskCacheValid(s.config, cached.value)) {
      orchLog(deps.logger, 'cache-stale', { stepName: key, kind: 'ask' })
    } else {
      // Kind-agnostic cache-hit dispatch: agent re-validates schema, worktree
      // reapplies the ALS cwd switch, commit is a no-op. Keeping the switch
      // exhaustive in step.ts stops the next step primitive from accreting a
      // third special case here.
      onCacheHit(s.config, key, cached.value)
      // Cached events do not mint a fresh span — the step's structured records
      // live in the original run's logs. Emit a run-level lifecycle line so the
      // timeline still shows the cache hit.
      deps.host.onLifecycleEvent({ type: 'step:cached', stepName: key })
      void deps.logger?.append('lifecycle', { type: 'step:cached', stepName: key }).catch(() => {})
      orchLog(deps.logger, 'cache-hit', { stepName: key, kind: s.config.kind })
      return cached.value
    }
  }

  const stepSpan = deps.logger?.forStep(key)
  const { config } = s
  let result: { value: unknown; entry: StepEntry }
  switch (config.kind) {
    case 'agent': {
      const mode = resolveMode(config, overrides)
      if (mode === 'interactive') {
        result = await runInteractiveStep(deps, captureLock, config, key, overrides, stepSpan)
      } else {
        result = await runAgentStep(deps, config, key, overrides, stepSpan)
      }
      break
    }
    case 'commit':
      result = await runCommitStep(deps, config, key, overrides)
      break
    case 'worktree':
      result = await runWorktreeStep(
        {
          gitService: deps.gitService,
          processService: deps.processService,
          clock: deps.clock,
        },
        config,
        key,
        currentCwd(deps.cwd),
        overrides,
      )
      break
    case 'ask': {
      // Emit step:start so the row appears in the steps-view projection
      // while the prompt is awaiting input — without this, the user can
      // navigate away from the prompt pane (Enter on another row) and have
      // no UI affordance to come back. See incident r-2026-05-22-212450-07.
      const askStartedAt = deps.clock.now()
      emitStepLifecycle(deps.host, stepSpan, {
        type: 'step:start',
        stepName: key,
        mode: 'interactive',
      })
      try {
        result = await runAskStep(
          {
            clock: deps.clock,
            host: deps.host,
            promptService: deps.promptService,
            interactivity: deps.interactivity,
          },
          config,
          key,
          overrides,
        )
      } catch (err) {
        emitStepLifecycle(deps.host, stepSpan, { type: 'step:failed', stepName: key, error: err })
        throw err
      }
      emitStepLifecycle(deps.host, stepSpan, {
        type: 'step:complete',
        stepName: key,
        durationMs: deps.clock.now() - askStartedAt,
      })
      break
    }
    case 'command': {
      const inParallel = currentParallelDepth() > 0
      const startedAt = deps.clock.now()
      emitStepLifecycle(deps.host, stepSpan, {
        type: 'step:start',
        stepName: key,
        mode: 'autonomous',
      })
      if (inParallel) {
        emitStepLifecycle(deps.host, stepSpan, {
          type: 'step:parallel-branch-update',
          stepName: key,
          branchStatus: 'running',
        })
      }
      try {
        result = await runCommandStep(
          {
            processService: deps.processService,
            clock: deps.clock,
            host: deps.host,
            ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
            ...(stepSpan !== undefined ? { stepSpan } : {}),
          },
          config,
          key,
          currentCwd(deps.cwd),
          overrides,
        )
      } catch (err) {
        const durationMs = deps.clock.now() - startedAt
        emitStepFailure(deps.host, stepSpan, key, err, inParallel, durationMs)
        throw err
      }
      const durationMs = deps.clock.now() - startedAt
      emitStepSuccess(deps.host, stepSpan, key, inParallel, durationMs)
      break
    }
    default: {
      const _exhaustive: never = config
      throw new Error(`Unexpected step kind: ${JSON.stringify(_exhaustive)}`)
    }
  }

  await deps.stateStore.saveStep(deps.runId, result.entry)
  orchLog(deps.logger, 'saveStep', { stepName: key, kind: s.config.kind })
  return result.value
}

// ---------------------------------------------------------------------------
// executeWorkflowFn — shared execution body for execute() and resume()
// ---------------------------------------------------------------------------

async function executeWorkflowFn(fn: WorkflowFn, deps: WorkflowDeps): Promise<void> {
  // One capture lock per workflow execution. Two concurrent Codex captures in
  // the same workflow (parallel interactive steps in the same execution)
  // serialize their capture windows through this lock; different executions
  // — and different test fixtures — each get their own factory instance.
  const captureLock = createCaptureLock()

  const run: RunFn = <T>(s: Step<T>, overrides?: RunOverrides): Promise<T> =>
    runStepOnce(deps, captureLock, s, overrides) as Promise<T>

  const startedAt = deps.clock.now()
  try {
    // Wrap the workflow body in an executionContext store so steps inside it
    // (including setWorkflowCwd from createWorktree) can mutate workflowCwd
    // and have subsequent run() calls observe the new cwd via currentCwd().
    //
    // `emitLifecycle` + `parallelBlockIdRef` give `parallel()` (in core/) a
    // narrow seam to fire `step:parallel-start` / `step:parallel-complete`
    // without depending on the host or WorkflowDeps.
    const emitLifecycle = (event: StepLifecycleEvent): void => deps.host.onLifecycleEvent(event)
    await executionContext.run(
      {
        parallelDepth: 0,
        workflowCwd: undefined,
        emitLifecycle,
        parallelBlockIdRef: { current: 0 },
      },
      () => fn(run, deps.args ?? {}),
    )
    await deps.stateStore.setStatus(deps.runId, 'completed', deps.clock.now())
    void deps.logger
      ?.append('lifecycle', {
        type: 'run-ended',
        status: 'completed',
        totalDurationMs: deps.clock.now() - startedAt,
      })
      .catch(() => {})
  } catch (err) {
    // Step-level failures mean the step ran to completion and produced an
    // unacceptable result — runner exited non-zero (StepError), a validator
    // rejected its output (ValidationError), structured output didn't match
    // the declared schema (SchemaValidationError), or one or more parallel
    // branches failed (ParallelError, which only wraps user-code throws from
    // parallel branches). The orchestrator itself did not crash. Anything
    // else (workflow-author bug, host failure, I/O error) earns the `crashed`
    // bucket so resume / dashboards can treat the two categories differently.
    const isStepLevelFailure =
      err instanceof StepError ||
      err instanceof ValidationError ||
      err instanceof SchemaValidationError ||
      err instanceof ParallelError
    const terminalStatus: 'failed' | 'crashed' = isStepLevelFailure ? 'failed' : 'crashed'
    try {
      await deps.stateStore.setStatus(deps.runId, terminalStatus, deps.clock.now())
    } catch {
      // Swallow setStatus failure — if initRun failed (disk full) or the state
      // file was deleted mid-run, the catch tries setStatus which throws.
      // Without this inner try-catch, the original error is lost.
      // For the resume() path, the run is known to exist (loadRun succeeded),
      // so this only fires on I/O errors (disk full, permissions).
    }
    void deps.logger
      ?.append('lifecycle', {
        type: 'run-ended',
        status: terminalStatus,
        totalDurationMs: deps.clock.now() - startedAt,
      })
      .catch(() => {})
    throw err
  }
}

export function workflow(name: string, fn: WorkflowFn): WorkflowExecutor {
  return {
    name,
    async execute(deps: WorkflowDeps): Promise<void> {
      await deps.stateStore.initRun(deps.runId, {
        workflowName: deps.workflowName,
        startedAt: deps.clock.now(),
        ...(deps.args !== undefined ? { args: deps.args } : {}),
      })
      await executeWorkflowFn(fn, deps)
    },
    async resume(deps: WorkflowDeps): Promise<void> {
      // Skip initRun() — resume validates existence and resets status directly.
      // See initRun() in FileStateStore for the execute() path.
      const state = await deps.stateStore.loadRun(deps.runId)
      if (state === undefined) throw new RunNotFoundError(deps.runId)
      if (state.status === 'completed') throw new ResumeError(deps.runId, state.status)
      await deps.stateStore.setStatus(deps.runId, 'running')
      await executeWorkflowFn(fn, deps)
    },
  }
}
