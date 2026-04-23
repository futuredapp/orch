import { randomUUID } from 'node:crypto'
import type { Host } from '../hosts/index.ts'
import { runRunner } from '../runners/index.ts'
import type { Clock, FsService, GitService, ProcessService } from '../services/index.ts'
import { GitCommandError } from '../services/index.ts'
import type { StateStore, StepEntry, TranscriptSidecar } from '../state/index.ts'
import {
  anyNeedsHeadSha,
  normalizeValidators,
  ValidationError,
  type ValidatorCtx,
  type ValidatorServices,
} from '../validators/index.ts'
import {
  InteractiveParallelError,
  ResumeError,
  RunNotFoundError,
  RunnerCapabilityError,
  StepError,
} from './errors.ts'
import { currentParallelDepth } from './execution-context.ts'
import { resolveView } from './view-registry.ts'

// Re-export so existing imports from './workflow.ts' remain valid.
export { InteractiveParallelError, ResumeError, RunNotFoundError, RunnerCapabilityError, StepError }

import { SchemaValidationError } from './schema.ts'
import type { AgentStepConfig, CommitStepConfig, Step } from './step.ts'
import {
  type InteractiveResult,
  type Path,
  type RunId,
  type StepMode,
  type StepName,
  stepName,
} from './types.ts'
import { outcomesToFailures, outcomesToPersisted, runValidators } from './validation-runner.ts'

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
   * under `.orch/state/<runId>/steps/*.transcript.ndjson`. The `StepEntry`
   * carries only a relative path + event count; `orch logs` streams the
   * sidecar. Absent in tests that don't care about persistence.
   */
  readonly transcriptSidecar?: TranscriptSidecar
  /** Agent-native hook: decouples interactive from TTY. */
  readonly onInteractive?: (ctx: InteractiveContext) => Promise<InteractiveResult>
  /** Injectable session ID generator. Defaults to crypto.randomUUID(). */
  readonly generateSessionId?: () => string
  /** CLI-supplied arguments. When omitted, the workflow callback sees `{}`. */
  readonly args?: WorkflowArgs
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

function revalidateCachedValue(config: AgentStepConfig, key: StepName, cached: unknown): void {
  if (config.returns === undefined) return
  const reparse = config.returns.zodSchema.safeParse(cached)
  if (!reparse.success) throw new SchemaValidationError(key, reparse.error)
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
// runInteractiveStep — executes an interactive step via foreground spawn
// ---------------------------------------------------------------------------

async function runInteractiveStep(
  deps: WorkflowDeps,
  config: AgentStepConfig,
  key: StepName,
  overrides: RunOverrides | undefined,
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

  const sessionId = deps.generateSessionId?.() ?? randomUUID()
  const prompt = assemblePrompt(config.prompt, overrides)

  deps.host.onLifecycleEvent({ type: 'step:start', stepName: key, mode: 'interactive' })
  const inParallel = currentParallelDepth() > 0
  if (inParallel) {
    deps.host.onLifecycleEvent({
      type: 'step:parallel-branch-update',
      stepName: key,
      branchStatus: 'running',
    })
  }

  // If an onInteractive handler is provided, delegate to it (agent-native).
  // Otherwise, require a TTY and do foreground spawn.
  let exitCode: number
  let durationMs: number

  if (deps.onInteractive) {
    const result = await deps.onInteractive({
      stepName: key,
      prompt,
      sessionId,
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

    const cmd = await config.agent.buildCommand({
      cwd: deps.cwd,
      env: {},
      prompt,
      extraArgs: [],
      mode: 'interactive',
      sessionId,
    })
    const result = await deps.host.runInteractive({
      argv: cmd.argv,
      env: cmd.env,
      cwd: deps.cwd,
      stepName: key,
    })
    exitCode = result.exitCode
    durationMs = result.durationMs
  }

  if (exitCode !== 0) {
    deps.host.onLifecycleEvent({ type: 'step:failed', stepName: key, error: `exit ${exitCode}` })
    if (inParallel) {
      deps.host.onLifecycleEvent({
        type: 'step:parallel-branch-update',
        stepName: key,
        branchStatus: 'failed',
        elapsedMs: durationMs,
      })
    }
    throw new StepError(key, exitCode, `interactive session exited ${exitCode}`)
  }

  const value: InteractiveResult = { exitCode, durationMs, sessionId }

  deps.host.onLifecycleEvent({ type: 'step:complete', stepName: key, durationMs })
  if (inParallel) {
    deps.host.onLifecycleEvent({
      type: 'step:parallel-branch-update',
      stepName: key,
      branchStatus: 'completed',
      elapsedMs: durationMs,
    })
  }

  const entry: StepEntry = {
    name: key,
    value,
    startedAt: deps.clock.now() - durationMs,
    endedAt: deps.clock.now(),
    artifacts: [],
    validations: [],
    mode: 'interactive',
    transcriptEventCount: 0,
    transcriptTruncated: false,
  }
  return { value, entry }
}

// ---------------------------------------------------------------------------
// runAgentStep — executes an autonomous step via a Runner adapter
// ---------------------------------------------------------------------------

function makeAgentEventHandler(
  deps: WorkflowDeps,
  key: StepName,
  stepTranscript: ReturnType<NonNullable<WorkflowDeps['transcriptSidecar']>['forStep']> | undefined,
  isSilent: boolean,
): (evt: import('../runners/index.ts').RunnerEvent) => void {
  return (evt) => {
    if (stepTranscript !== undefined) {
      // Fire-and-forget: events arrive synchronously; the append is awaited
      // on the background chain inside the sidecar so ordering stays stable.
      void stepTranscript.append(evt).catch(() => {})
    }
    if (!isSilent) deps.host.onRunnerEvent(evt, key)
  }
}

async function runAgentStep(
  deps: WorkflowDeps,
  config: AgentStepConfig,
  key: StepName,
  overrides: RunOverrides | undefined,
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
  const inParallel = currentParallelDepth() > 0

  deps.host.onLifecycleEvent({ type: 'step:start', stepName: key, mode: 'autonomous' })
  if (inParallel) {
    deps.host.onLifecycleEvent({
      type: 'step:parallel-branch-update',
      stepName: key,
      branchStatus: 'running',
    })
  }

  const normalized = normalizeValidators(config.validate, key)
  const headSha = anyNeedsHeadSha(normalized)
    ? await safeHeadSha(deps.gitService, deps.cwd)
    : undefined
  const preRunSnapshot = headSha !== undefined ? { headSha } : undefined

  const startedAt = deps.clock.now()
  // Sidecar captures every RunnerEvent (silent steps included — `orch logs`
  // needs the trace even when the host renders nothing). Errors are logged
  // to stderr but do not abort the step; transcript loss is recoverable,
  // a step failure from a fs hiccup is not.
  const stepTranscript = deps.transcriptSidecar?.forStep(key)
  const runnerDeps = {
    processService: deps.processService,
    clock: deps.clock,
    onEvent: makeAgentEventHandler(deps, key, stepTranscript, isSilent),
  }
  const result = await runRunner(
    config.agent,
    {
      cwd: deps.cwd,
      env: {},
      prompt: assemblePrompt(config.prompt, overrides),
      extraArgs: [],
      ...(config.returns !== undefined
        ? { schema: { jsonSchema: config.returns.jsonSchema } }
        : {}),
    },
    runnerDeps,
  )

  if (result.finalEvent.type === 'error' || result.exitCode !== 0) {
    const msg =
      result.finalEvent.type === 'error'
        ? result.finalEvent.message
        : `runner exited ${result.exitCode}`
    deps.host.onLifecycleEvent({ type: 'step:failed', stepName: key, error: msg })
    if (inParallel) {
      deps.host.onLifecycleEvent({
        type: 'step:parallel-branch-update',
        stepName: key,
        branchStatus: 'failed',
        elapsedMs: deps.clock.now() - startedAt,
      })
    }
    throw new StepError(key, result.exitCode, msg)
  }

  const rawValue = config.agent.extractStructuredOutput(result.finalEvent)
  const value = validateSchemaOutput(config, key, rawValue)

  const validatorCtx: ValidatorCtx = {
    stepName: key,
    cwd: deps.cwd,
    value,
    ...(preRunSnapshot !== undefined ? { preRunSnapshot } : {}),
  }
  const services: ValidatorServices = { fs: deps.fsService, git: deps.gitService }
  const outcomes = await runValidators(normalized, services, validatorCtx)
  const failures = outcomesToFailures(outcomes)
  if (failures.length > 0) {
    throw new ValidationError(key, failures)
  }

  const durationMs = deps.clock.now() - startedAt
  deps.host.onLifecycleEvent({ type: 'step:complete', stepName: key, durationMs })
  if (inParallel) {
    deps.host.onLifecycleEvent({
      type: 'step:parallel-branch-update',
      stepName: key,
      branchStatus: 'completed',
      elapsedMs: durationMs,
    })
  }

  const entry = buildAgentEntry({
    key,
    value,
    startedAt,
    endedAt: deps.clock.now(),
    preRunSnapshot,
    outcomes,
    transcriptMeta: stepTranscript?.snapshot(),
  })
  return { value, entry }
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
  const clean = await deps.gitService.isClean(deps.cwd)

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

  await deps.gitService.stageAll(deps.cwd)
  const sha = await deps.gitService.commit(deps.cwd, config.message)
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
  s: Step,
  overrides: RunOverrides | undefined,
): Promise<unknown> {
  const key = stepName(overrides?.as ?? s.name)

  const state = await deps.stateStore.loadRun(deps.runId)
  const cached = state?.steps[key]
  if (cached !== undefined) {
    const { config } = s
    if (config.kind === 'agent') revalidateCachedValue(config, key, cached.value)
    deps.host.onLifecycleEvent({ type: 'step:cached', stepName: key })
    return cached.value
  }

  const { config } = s
  let result: { value: unknown; entry: StepEntry }
  switch (config.kind) {
    case 'agent': {
      const mode = resolveMode(config, overrides)
      if (mode === 'interactive') {
        result = await runInteractiveStep(deps, config, key, overrides)
      } else {
        result = await runAgentStep(deps, config, key, overrides)
      }
      break
    }
    case 'commit':
      result = await runCommitStep(deps, config, key, overrides)
      break
    default: {
      const _exhaustive: never = config
      throw new Error(`Unexpected step kind: ${JSON.stringify(_exhaustive)}`)
    }
  }

  await deps.stateStore.saveStep(deps.runId, result.entry)
  return result.value
}

// ---------------------------------------------------------------------------
// executeWorkflowFn — shared execution body for execute() and resume()
// ---------------------------------------------------------------------------

async function executeWorkflowFn(fn: WorkflowFn, deps: WorkflowDeps): Promise<void> {
  const run: RunFn = <T>(s: Step<T>, overrides?: RunOverrides): Promise<T> =>
    runStepOnce(deps, s, overrides) as Promise<T>

  try {
    await fn(run, deps.args ?? {})
    await deps.stateStore.setStatus(deps.runId, 'completed', deps.clock.now())
  } catch (err) {
    try {
      await deps.stateStore.setStatus(deps.runId, 'crashed', deps.clock.now())
    } catch {
      // Swallow setStatus failure — if initRun failed (disk full) or the state
      // file was deleted mid-run, the catch tries setStatus which throws.
      // Without this inner try-catch, the original error is lost.
      // For the resume() path, the run is known to exist (loadRun succeeded),
      // so this only fires on I/O errors (disk full, permissions).
    }
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
