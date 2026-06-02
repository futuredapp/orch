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
// Addressing env-var names live on the Runner port (the executor↔runner spawn
// contract) — not in a concrete runner — so the core executor can name them
// without importing a runner adapter.
import {
  type CaptureError,
  type CaptureLock,
  ORCH_PARENT_PID_ENV,
  ORCH_RUN_STATE_DIR_ENV,
  ORCH_STEP_KEY_ENV,
  type RunnerContext,
} from '../runners/types.ts'
import type { Clock, FsService, GitService, ProcessService } from '../services/index.ts'
import { GitCommandError, mergeEnv } from '../services/index.ts'
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
  AutoStopUnsupportedError,
  InteractiveParallelError,
  ResumeError,
  RunNotFoundError,
  RunnerCapabilityError,
  StepError,
  StepNameCollisionError,
} from './errors.ts'
import {
  currentCwd,
  currentParallelDepth,
  currentSubworkflowPath,
  executionContext,
  isInsideParallel,
} from './execution-context.ts'
import type { RecoveryStrategy } from './recovery/index.ts'
import type { ResumeRegistry } from './resume-registry.ts'
import { type StepTimer, withStepLifecycle } from './step-lifecycle.ts'
import { resolveView } from './view-registry.ts'

// Re-export so existing imports from './workflow.ts' remain valid.
export { InteractiveParallelError, ResumeError, RunNotFoundError, RunnerCapabilityError, StepError }

import { ParallelError } from './parallel.ts'
import { stableHashHex } from './prompt-file/cache-key.ts'
import {
  assertPromptVars,
  type PromptVars,
  type PromptVarsBound,
  substitute,
} from './prompt-file/substitute.ts'
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

// This file intentionally remains the workflow executor's coordination hub:
// it owns run()/resume(), cache replay, validation, lifecycle fan-out, and
// CLI args plumbing. Specialized surfaces such as runWorkflow live in smaller
// sibling modules once they need their own lifecycle or state machinery.

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

interface RunOverridesBase {
  readonly as?: string
  readonly prompt?: string
  readonly extraContext?: JsonValue
  readonly extraPrompt?: string
  readonly mode?: StepMode
}

// `vars` is REQUIRED when the step's typed contract has required keys;
// OPTIONAL otherwise. The split is driven by `Record<string, never> extends V`:
// the no-vars sentinel is assignable to V only when V has no required keys
// (e.g. `Record<string, never>`, `{ a?: string }`, or the widened
// `PromptVarsBound`).
type IsEmptyOrAllOptional<V> = Record<string, never> extends V ? true : false

type VarsField<V extends PromptVarsBound> =
  IsEmptyOrAllOptional<V> extends true ? { readonly vars?: V } : { readonly vars: V }

/**
 * Per-call overrides for `run(STEP, …)`.
 *
 * The generic `V` carries the step's inferred `vars` contract from
 * `Step<TResult, TVars>`. When `V` has required keys, the `vars` field is
 * required at the call site; when it has only optional keys (or none), it is
 * optional. The widened default `V = PromptVars` keeps existing call sites
 * that never specified the generic working unchanged.
 *
 * `prompt:` set as an override bypasses substitution entirely (R10) — vars
 * are silently ignored at runtime in that case. The compile-time contract
 * still demands `vars` be supplied when V has required keys, so the standard
 * "bypass" recipe is to also supply a valid `vars` object that will be
 * ignored, or to weaken the step's V via a cast.
 */
export type RunOverrides<V extends PromptVarsBound = PromptVars> = RunOverridesBase & VarsField<V>

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
  | {
      readonly type: 'step:start'
      readonly stepName: StepName
      readonly mode: StepMode
      readonly runnerName?: string
      readonly subPath?: readonly string[]
      readonly insideParallel?: true
    }
  | {
      readonly type: 'step:complete'
      readonly stepName: StepName
      readonly durationMs: number
      readonly subPath?: readonly string[]
      readonly insideParallel?: true
    }
  | {
      readonly type: 'step:failed'
      readonly stepName: StepName
      readonly error: unknown
      readonly subPath?: readonly string[]
      readonly insideParallel?: true
    }
  | {
      readonly type: 'step:cached'
      readonly stepName: StepName
      readonly subPath?: readonly string[]
      readonly insideParallel?: true
    }
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
  | {
      /** Fired by `runWorkflow` immediately before invoking the sub body
       *  (R14). `depth` is the new sub-frame depth (parent depth + 1).
       *  `insideParallel` piggybacks the ALS signal so the plain host's
       *  divider suppression rule (R16) does not need to consult ALS. */
      readonly type: 'subworkflow:enter'
      readonly name: string
      readonly depth: number
      readonly subPath?: readonly string[]
      readonly insideParallel?: true
    }
  | {
      /** Fired by `runWorkflow` after the sub body resolves OR rejects (R14).
       *  `outcome: 'failed'` is set when the sub threw; the original error
       *  is rethrown to the parent body AFTER this event fires (R10). */
      readonly type: 'subworkflow:exit'
      readonly name: string
      readonly depth: number
      readonly subPath?: readonly string[]
      readonly durationMs: number
      readonly outcome: 'completed' | 'failed'
      readonly insideParallel?: true
    }
  | {
      /** Synthesized when the host's `onLifecycleEvent` throws on a
       *  `subworkflow:enter` or `subworkflow:exit` event. Enter-throws
       *  propagate (so the sub does not run); exit-throws are SUPPRESSED
       *  by `runWorkflow` and recorded here so the post-hoc trace exists
       *  (resolves the 2026-05-31 R10 observability gap). Promoted to a
       *  typed variant so TS exhaustiveness checks cover every consumer. */
      readonly type: 'host-error'
      readonly source: 'subworkflow:enter' | 'subworkflow:exit'
      readonly name: string
      readonly depth: number
      readonly message: string
    }
  | {
      /** Fired once when the workflow body settles — after the terminal
       *  `step:*` events, on BOTH the success and failure paths (on failure,
       *  immediately before the executor re-throws). Mirrors the `run-ended`
       *  logger line, but fanned through `host.onLifecycleEvent` so hosts can
       *  finalize run-scoped UI (e.g. the cmux host clears its sidebar pills
       *  and fires the completion/failure notification) the moment the run
       *  ends — NOT at host teardown, which two-pane defers until the user
       *  dismisses the end-of-run summary. */
      readonly type: 'run:ended'
      readonly status: 'completed' | 'failed' | 'crashed'
      readonly durationMs: number
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
  /**
   * Workflow-level default error-recovery strategy for autonomous agent steps
   * (R14). A step's own `recovery:` overrides this; when neither is set the
   * built-in `backoffResume()` applies. Resolved per step via
   * `resolveRecoveryStrategy`. Consumed by the recovery loop (U7).
   */
  readonly recovery?: RecoveryStrategy
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
  /**
   * Maximum nesting depth for `runWorkflow` invocations (R21). Defaults to 8.
   * The snapshot is taken at workflow-root construction and stashed on the
   * ALS frame; `runWorkflow`'s depth guard reads the snapshot, never a
   * process-global. Per-execution rather than a module-level slot keeps
   * tests isolated and lets concurrent in-process executions carry
   * different bounds.
   */
  readonly maxSubworkflowDepth?: number
}

/** R21 default — chains deeper than 8 typically signal accidental
 *  recursion. Override via `WorkflowDeps.maxSubworkflowDepth` when nesting
 *  is intentional. */
export const DEFAULT_MAX_SUBWORKFLOW_DEPTH = 8

// ---------------------------------------------------------------------------
// WorkflowFn — the function a workflow author writes. `args` is optional
// in the signature so legacy `async (run) => ...` callbacks still compile.
// Generic Args carries the typed argument contract for the body. Defaulting
// Args to WorkflowArgs keeps every existing call site source-compatible.
// ---------------------------------------------------------------------------

export type WorkflowFn<Args extends WorkflowArgs = WorkflowArgs> = (
  run: RunFn,
  args: Args,
) => Promise<void>

// ---------------------------------------------------------------------------
// RunFn — the signature of the `run` closure passed to workflow functions
// ---------------------------------------------------------------------------

/** Override with `mode: 'interactive'` always yields InteractiveResult. */
export interface RunFn {
  <T, V extends PromptVarsBound>(
    step: Step<T, V>,
    overrides: RunOverrides<V> & { readonly mode: 'interactive' },
  ): Promise<InteractiveResult>
  <T, V extends PromptVarsBound>(step: Step<T, V>, overrides?: RunOverrides<V>): Promise<T>
}

// ---------------------------------------------------------------------------
// WorkflowExecutor — returned by workflow()
// ---------------------------------------------------------------------------
//
// `bodyHandle` is a module-private symbol used by `runWorkflow` to invoke a
// sub's body inline. The symbol is NOT exported from `src/core/index.ts`; the
// only legitimate reader imports it directly from `src/core/workflow.ts`.
// Symbol-keyed members are hidden from `Object.keys`, `for...in`, and IDE
// autocomplete, so the external surface (`name`, `execute`, `resume`) is
// unchanged for consumers.

export const bodyHandle: unique symbol = Symbol('orch.workflow.body')

export interface WorkflowExecutor<Args extends WorkflowArgs = WorkflowArgs> {
  readonly name: string
  execute(deps: WorkflowDeps): Promise<void>
  /** Resume a crashed or stuck run. Accepts 'crashed' or 'running' status.
   *  Throws RunNotFoundError if the run does not exist.
   *  Throws ResumeError if the run is already completed.
   *  Single-process only — no cross-process locking. */
  resume(deps: WorkflowDeps): Promise<void>
  /** Module-private body handle. Read only by `runWorkflow` via direct symbol
   *  import. Not enumerable and not part of the public `src/core/index.ts`
   *  barrel. */
  readonly [bodyHandle]: WorkflowFn<Args>
}

// ---------------------------------------------------------------------------
// assemblePrompt — builds the final prompt from defaults and overrides
// ---------------------------------------------------------------------------

function assemblePrompt(
  defaultPrompt: string | undefined,
  overrides: RunOverrides | undefined,
  stepNameForCtx?: string,
): string {
  const usingReplacement = overrides?.prompt !== undefined
  const base = overrides?.prompt ?? defaultPrompt ?? ''
  // R10: overrides.prompt is a full replacement — skip substitution. The vars
  // field is silently ignored in that case (caller chose to bypass the
  // template).
  const vars = overrides?.vars
  const substituted =
    !usingReplacement && (templateHasPlaceholders(base) || hasNonEmptyVars(vars))
      ? substitute(base, vars ?? {}, stepNameForCtx ? { stepName: stepNameForCtx } : {})
      : base
  const parts = [substituted]
  if (overrides?.extraContext !== undefined) {
    parts.push(JSON.stringify(overrides.extraContext, null, 2))
  }
  if (overrides?.extraPrompt) parts.push(overrides.extraPrompt)
  return parts.filter(Boolean).join('\n\n')
}

// Cheap pre-check so a static-prompt step with no vars short-circuits the
// strict both-directions substitute() validation (which would otherwise throw
// extra-key when a static step receives `vars: {}` — that's fine, but also when
// the same step is reached without overrides at all).
// Matches `{{name}}` and the optional form `{{name?}}` (kept in sync with
// PLACEHOLDER_RE in `src/core/prompt-file/substitute.ts`). Missing the `?`
// here would silently take static-prompt short-circuit on `{{name?}}` and
// emit the raw token to the runner.
const PLACEHOLDER_PROBE = /\{\{\s*[a-zA-Z_][a-zA-Z0-9_]*\s*\??\s*\}\}/
function templateHasPlaceholders(template: string): boolean {
  return PLACEHOLDER_PROBE.test(template)
}

function hasNonEmptyVars(vars: PromptVars | undefined): boolean {
  return vars !== undefined && Object.keys(vars).length > 0
}

// ---------------------------------------------------------------------------
// deriveStepKey — fold `overrides.vars` into the cache key
// ---------------------------------------------------------------------------
//
// Caller's explicit `as:` wins (no vars-hash appended). Otherwise, when
// `overrides.vars` is non-empty, append `:vars=<16-hex>` to the step name so
// two `run(STEP, { vars: ... })` calls with different vars populate distinct
// cache entries. Empty vars (or no overrides) leave the key unchanged for
// back-compat with workflows that don't use the new contract.

/** @internal Exported only for focused cache-key regression tests. */
export function deriveStepKey(
  name: StepName,
  overrides: RunOverrides | undefined,
  subPath: readonly string[] = [],
): string {
  // U4: explicit `as:` override wins and bypasses sub-folding. Authors who
  // declare `as: 'override'` keep the legacy flat key (documented limitation
  // so they can opt back into pre-sub-aware behavior).
  if (overrides?.as !== undefined) return overrides.as
  // Defense-in-depth: validate vars shape before folding into the cache key
  // so an invalid value (e.g. a typed cast slipping through compile-time)
  // cannot poison the on-disk cache with an entry that runtime substitute()
  // would later reject. The assertion is a no-op for the common empty case.
  const vars = overrides?.vars ?? {}
  if (Object.keys(vars).length > 0) assertPromptVars(vars, { stepName: name })
  const hash = stableHashHex(vars)
  // Sub-path is folded BEFORE the vars suffix so a sub-internal step with vars
  // produces a single contiguous key like `outer>plan:vars-<hex>` (legal in
  // STEP_NAME_PATTERN). The `>` separator is illegal as a first character and
  // the workflow-name validator rejects `>` in names, so the new key shape
  // cannot collide with a hand-written step name.
  const base = subPath.length === 0 ? (name as string) : `${subPath.join('>')}>${name as string}`
  if (hash === '') return base
  return `${base}:vars-${hash}`
}

// ---------------------------------------------------------------------------
// addressingEnv — the per-spawn ctx.env addressing values (U1)
// ---------------------------------------------------------------------------
//
// Written into BOTH spawn paths' `ctx.env` identically so the predictable fake
// resolves its control transport from the run-time key under the run state
// dir, regardless of autonomous vs. interactive. Real runners receive the same
// three vars via the passthrough env policy and ignore them. `ORCH_PARENT_PID`
// is orch's own pid: the interactive self-reap (U6) cannot read it any other
// way because a tmux-spawned child's `process.ppid` is the pane, not orch.
function addressingEnv(deps: WorkflowDeps, key: StepName): Record<string, string> {
  return {
    [ORCH_STEP_KEY_ENV]: key as string,
    [ORCH_RUN_STATE_DIR_ENV]: deps.stateStore.runDir(deps.runId) as string,
    [ORCH_PARENT_PID_ENV]: String(process.pid),
  }
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

// Step lifecycle emission (`step:start`/`step:complete`/`step:failed` plus the
// parallel branch-update supplement) lives in `./step-lifecycle.ts`; every
// per-kind executor below brackets its body with `withStepLifecycle`.

function errorLogFields(err: unknown): JsonObject {
  const base: Record<string, unknown> = { error: String(err) }
  if (err instanceof Error) {
    base.errorName = err.name
    base.errorMessage = err.message
  }
  return base
}

function onceLoggedAutoStopCleanup(
  stepSpan: StepSpan | undefined,
  cleanup: () => Promise<void>,
): () => Promise<void> {
  let cleanupPromise: Promise<void> | undefined
  return async (): Promise<void> => {
    cleanupPromise ??= cleanup().catch((err) => {
      void stepSpan
        ?.append('lifecycle', {
          type: 'interactive-auto-stop-cleanup-failed',
          ...errorLogFields(err),
        })
        .catch(() => {})
    })
    await cleanupPromise
  }
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
// prepareAutoStopForStep — invoke the runner's auto-stop preparation.
//
// Kept out of `runInteractiveStep` (already long) and behind the same
// `autoStop && prepareAutoStop` predicate the fail-fast guard uses. Returns the
// runner-injected env additions (merged on top of the command env by the
// caller) and the cleanup handle the host runs in its `finally`.
// ---------------------------------------------------------------------------

async function prepareAutoStopForStep(
  config: AgentStepConfig,
  buildCtx: RunnerContext,
): Promise<{
  readonly extras: Readonly<Record<string, string>>
  readonly onCleanup?: () => Promise<void>
}> {
  if (config.autoStop !== true || typeof config.agent.prepareAutoStop !== 'function') {
    return { extras: {} }
  }
  const prep = await config.agent.prepareAutoStop(buildCtx)
  return { extras: prep.env, onCleanup: prep.cleanup }
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

  // Guard: auto-stop capability. Fail fast — before any pane is spawned — when
  // a step opted into auto-stop but its runner can't register a stop hook.
  const autoStop = config.autoStop === true
  if (autoStop && typeof config.agent.prepareAutoStop !== 'function') {
    throw new AutoStopUnsupportedError(key, config.agent.name)
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

  return withStepLifecycle(
    {
      host: deps.host,
      stepSpan,
      clock: deps.clock,
      key,
      mode: 'interactive',
      trackParallel: true,
      runnerName: config.agent.name,
    },
    (timer) =>
      produceInteractiveStep(deps, captureLock, config, key, overrides, stepSpan, autoStop, timer),
  )
}

// The run-and-produce body for an interactive step, lifted out of the
// `withStepLifecycle` closure (mirrors `produceAgentStep`). `autoStop` is
// resolved by the caller's fail-fast guard and passed in; everything else is
// local. `timer.stamp` reports the session's own duration on the lifecycle
// events rather than the envelope's wall-clock (which would also count capture
// + buildCommand + logging).
//
// Over the cognitive-complexity budget (CLAUDE.md rule #5): the
// onInteractive-vs-foreground-spawn fork, the pre-spawn session-id capture
// window, and the auto-stop cleanup wiring are one indivisible sequence —
// splitting further would hide the spawn ordering that the comments exist to
// make legible.
async function produceInteractiveStep(
  deps: WorkflowDeps,
  captureLock: CaptureLock,
  config: AgentStepConfig,
  key: StepName,
  overrides: RunOverrides | undefined,
  stepSpan: StepSpan | undefined,
  autoStop: boolean,
  timer: StepTimer,
): Promise<{ value: InteractiveResult; entry: StepEntry }> {
  const orchSessionId = deps.generateSessionId?.() ?? randomUUID()
  const prompt = assemblePrompt(config.prompt, overrides, key)
  const startedAtStep = deps.clock.now()
  const cwd = currentCwd(deps.cwd)

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

    const buildCtx: RunnerContext = {
      cwd,
      // U1: identical addressing values to the autonomous path so an
      // interactive fake resolves the same control transport (R7).
      env: addressingEnv(deps, key),
      prompt,
      extraArgs: [],
      mode: 'interactive',
      sessionId: orchSessionId,
      ...(autoStop ? { autoStop: true } : {}),
    }
    const cmd = await config.agent.buildCommand(buildCtx)
    argv = cmd.argv
    // Auto-stop preparation runs after buildCommand (it only needs ctx). Its
    // env additions (e.g. Codex's CODEX_HOME) ride the `extras` layer — below
    // `buildCtx.env` so a workflow author's step env still wins last. The
    // cleanup handle is once-guarded: tmux can invoke it at its pane-safe
    // point, and the executor finally still owns the register/plain-host
    // failure paths.
    const autoStopPrep = await prepareAutoStopForStep(config, buildCtx)
    const autoStopCleanup =
      autoStopPrep.onCleanup === undefined
        ? undefined
        : onceLoggedAutoStopCleanup(stepSpan, autoStopPrep.onCleanup)
    cmdEnv = mergeEnv(cmd.env, autoStopPrep.extras, buildCtx.env)
    let result: Awaited<ReturnType<Host['runInteractive']>>
    try {
      result = await deps.host.runInteractive({
        argv: cmd.argv,
        env: cmdEnv,
        cwd,
        stepName: key,
        ...(autoStop ? { autoStop: true } : {}),
        ...(autoStopCleanup ? { onCleanup: autoStopCleanup } : {}),
      })
    } finally {
      await autoStopCleanup?.()
    }
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

  // Stamped before the failure branch so success and failure agree on duration.
  timer.stamp(durationMs)

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
    throw new StepError(key, exitCode, `interactive session exited ${exitCode}`)
  }

  // InteractiveResult.sessionId must always be a string (Zod requires UUID
  // shape). On capture failure we surface the orch-generated UUID to keep the
  // value schema honest — the top-level `entry.sessionId` is what drives
  // resume and IS omitted via the conditional below.
  const value: InteractiveResult = { exitCode, durationMs, sessionId: persistedSessionId }

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

  return withStepLifecycle(
    {
      host: deps.host,
      stepSpan,
      clock: deps.clock,
      key,
      mode: 'autonomous',
      trackParallel: true,
      runnerName: config.agent.name,
    },
    () => produceAgentStep(deps, config, key, overrides, stepSpan, isSilent),
  )
}

// The run-and-produce body for an autonomous step, lifted out of the
// `withStepLifecycle` closure so the envelope doesn't add a nesting level to an
// already-branchy executor. Throws `StepError` / `ValidationError` /
// `SchemaValidationError`; the envelope turns those into `step:failed`. Uses
// wall-clock for the lifecycle duration (no `timer.stamp`).
async function produceAgentStep(
  deps: WorkflowDeps,
  config: AgentStepConfig,
  key: StepName,
  overrides: RunOverrides | undefined,
  stepSpan: StepSpan | undefined,
  isSilent: boolean,
): Promise<{ value: unknown; entry: StepEntry }> {
  const cwd = currentCwd(deps.cwd)
  const normalized = normalizeValidators(config.validate, key)
  const headSha = anyNeedsHeadSha(normalized) ? await safeHeadSha(deps.gitService, cwd) : undefined
  const preRunSnapshot = headSha !== undefined ? { headSha } : undefined

  const startedAt = deps.clock.now()
  const prompt = assemblePrompt(config.prompt, overrides, key)
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
    // U1: addressing values ride ctx.env (passthrough policy). The fake reads
    // them to resolve its control transport; real runners ignore them.
    env: addressingEnv(deps, key),
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

// `AnyStep` — the existential shape `runStepOnce` consumes. The dispatcher
// never reads `TResult` or `TVars` at runtime (they exist purely for the
// `RunFn` compile-time contract), so the dispatch surface uses one named
// alias instead of the prior `s as unknown as Step<T>` double-cast.
type AnyStep = Step<unknown, PromptVarsBound>

interface StepKeyOwner {
  readonly subPath: readonly string[]
  readonly subCallId?: string
}

function sameSubPath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((seg, i) => seg === b[i])
}

function assertNoExecutionCollision(
  step: AnyStep,
  prior: StepKeyOwner,
  attempted: StepKeyOwner,
): void {
  if (
    !sameSubPath(prior.subPath, attempted.subPath) ||
    (attempted.subCallId !== undefined && prior.subCallId !== attempted.subCallId)
  ) {
    throw new StepNameCollisionError(step.name, prior.subPath, attempted.subPath)
  }
}

async function runStepOnce(
  deps: WorkflowDeps,
  captureLock: CaptureLock,
  keyOwnersThisExecution: Map<string, StepKeyOwner>,
  s: AnyStep,
  overrides: RunOverrides | undefined,
): Promise<unknown> {
  // U4: fold the active sub-path into the cache key. The `as:` override in
  // `deriveStepKey` bypasses sub-folding (documented authoring opt-out).
  const subPath = currentSubworkflowPath()
  const key = stepName(deriveStepKey(s.name, overrides, subPath))
  const subStore = executionContext.getStore()
  const subCallId = subStore?.subCallId
  const insideParallel = isInsideParallel()
  const attemptedOwner: StepKeyOwner = {
    subPath,
    ...(subCallId !== undefined ? { subCallId } : {}),
  }

  // Register the runner for resume lookup before any short-circuit. Cache hits
  // on `orch resume` populate the registry progressively so the right pane
  // can resolve a past interactive step the moment the executor reaches it.
  // Restricted to the interactive branch — autonomous steps are out of scope
  // for the history-resume feature (origin F8).
  if (s.config.kind === 'agent' && resolveMode(s.config, overrides) === 'interactive') {
    deps.resumeRegistry?.register(key, s.config.agent)
  }

  // U4 R20 case-b — same-execution second ownership of the same key by a
  // different sub invocation must throw BEFORE the cache short-circuit,
  // otherwise the second invocation silently replays the first's value. On
  // resume, a prior-run cached entry is allowed to be claimed once by the
  // current execution; a second fresh subCallId for the same key then collides.
  const executionOwner = keyOwnersThisExecution.get(key)
  if (executionOwner !== undefined) {
    assertNoExecutionCollision(s, executionOwner, attemptedOwner)
  } else {
    keyOwnersThisExecution.set(key, attemptedOwner)
  }

  const state = await deps.stateStore.loadRun(deps.runId)
  const cached = state?.steps[key]
  if (cached !== undefined) {
    const cachedOwner: StepKeyOwner = {
      subPath: cached.subPath ?? [],
      ...(cached.subCallId !== undefined ? { subCallId: cached.subCallId } : {}),
    }
    if (!sameSubPath(cachedOwner.subPath, attemptedOwner.subPath)) {
      throw new StepNameCollisionError(s.name, cachedOwner.subPath, attemptedOwner.subPath)
    }
  }
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
      const cachedLifecycle: StepLifecycleEvent = {
        type: 'step:cached',
        stepName: key,
        ...(subPath.length > 0 ? { subPath } : {}),
        ...(insideParallel ? { insideParallel: true as const } : {}),
      }
      deps.host.onLifecycleEvent(cachedLifecycle)
      void deps.logger?.append('lifecycle', cachedLifecycle).catch(() => {})
      orchLog(deps.logger, 'cache-hit', { stepName: key, kind: s.config.kind })
      keyOwnersThisExecution.set(key, attemptedOwner)
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
      // step:start makes the row appear in the steps-view projection while the
      // prompt is awaiting input — without it the user can navigate away from
      // the prompt pane (Enter on another row) with no affordance to come back.
      // See incident r-2026-05-22-212450-07. `trackParallel: false`: ask throws
      // AskParallelError before producing a branch, so it never branch-updates.
      result = await withStepLifecycle(
        {
          host: deps.host,
          stepSpan,
          clock: deps.clock,
          key,
          mode: 'interactive',
          trackParallel: false,
        },
        async () =>
          runAskStep(
            {
              clock: deps.clock,
              host: deps.host,
              promptService: deps.promptService,
              interactivity: deps.interactivity,
            },
            config,
            key,
            overrides,
          ),
      )
      break
    }
    case 'command': {
      result = await withStepLifecycle(
        {
          host: deps.host,
          stepSpan,
          clock: deps.clock,
          key,
          mode: 'autonomous',
          trackParallel: true,
        },
        async () =>
          runCommandStep(
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
          ),
      )
      break
    }
    default: {
      const _exhaustive: never = config
      throw new Error(`Unexpected step kind: ${JSON.stringify(_exhaustive)}`)
    }
  }

  // U4 / U7 / U9 — persist the sub-frame markers so resume reconstructs
  // grouping (U8 projection) and so the parallel-suppression decision can be
  // taken without re-reading lifecycle.ndjson (U9 / AE13).
  const augmentedEntry: StepEntry = {
    ...result.entry,
    ...(subPath.length > 0 ? { subPath } : {}),
    ...(subCallId !== undefined ? { subCallId } : {}),
    ...(insideParallel ? { insideParallel: true as const } : {}),
  }
  await deps.stateStore.saveStep(deps.runId, augmentedEntry)
  keyOwnersThisExecution.set(key, attemptedOwner)
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
  // U4 R20 — tracks cache-key ownership during THIS execution. A cached
  // entry from a prior execution may be claimed once on resume, but a second
  // fresh sub-call-id for the same key collides instead of replaying the
  // first invocation's value.
  const keyOwnersThisExecution = new Map<string, StepKeyOwner>()

  const run: RunFn = <T, V extends PromptVarsBound>(
    s: Step<T, V>,
    overrides?: RunOverrides<V>,
  ): Promise<T> =>
    runStepOnce(
      deps,
      captureLock,
      keyOwnersThisExecution,
      // Cast away the V generic — runStepOnce treats every step uniformly at
      // runtime and the cache-key fold uses `overrides.vars` directly.
      s as AnyStep,
      overrides as RunOverrides | undefined,
    ) as Promise<T>

  const startedAt = deps.clock.now()
  // `emitLifecycle` + `parallelBlockIdRef` give `parallel()` (in core/) a
  // narrow seam to fire `step:parallel-start` / `step:parallel-complete`
  // without depending on the host or WorkflowDeps. Hoisted above the try so the
  // catch branch can fan the terminal `run:ended` event too.
  const emitLifecycle = (event: StepLifecycleEvent): void => deps.host.onLifecycleEvent(event)
  try {
    // Wrap the workflow body in an executionContext store so steps inside it
    // (including setWorkflowCwd from createWorktree) can mutate workflowCwd
    // and have subsequent run() calls observe the new cwd via currentCwd().
    // U3: populate `runFnRef`, `loggerRef`, and `maxSubworkflowDepth` at the
    // root frame so `runWorkflow` reads them via ALS without taking
    // WorkflowDeps directly. The snapshot makes the depth bound
    // per-execution (no process-globals, no test pollution).
    await executionContext.run(
      {
        parallelDepth: 0,
        workflowCwd: undefined,
        emitLifecycle,
        parallelBlockIdRef: { current: 0 },
        runFnRef: run,
        ...(deps.logger !== undefined ? { loggerRef: deps.logger } : {}),
        maxSubworkflowDepth: deps.maxSubworkflowDepth ?? DEFAULT_MAX_SUBWORKFLOW_DEPTH,
      },
      () => fn(run, deps.args ?? {}),
    )
    await deps.stateStore.setStatus(deps.runId, 'completed', deps.clock.now())
    const completedDurationMs = deps.clock.now() - startedAt
    void deps.logger
      ?.append('lifecycle', {
        type: 'run-ended',
        status: 'completed',
        totalDurationMs: completedDurationMs,
      })
      .catch(() => {})
    emitLifecycle({ type: 'run:ended', status: 'completed', durationMs: completedDurationMs })
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
    const failedDurationMs = deps.clock.now() - startedAt
    void deps.logger
      ?.append('lifecycle', {
        type: 'run-ended',
        status: terminalStatus,
        totalDurationMs: failedDurationMs,
      })
      .catch(() => {})
    // Fan the terminal event BEFORE re-throwing so hosts finalize run-scoped UI
    // (cmux failure notify + pill clear) the moment the run settles, not at the
    // teardown that the re-thrown error eventually triggers.
    emitLifecycle({ type: 'run:ended', status: terminalStatus, durationMs: failedDurationMs })
    throw err
  }
}

function argsFromDeps<Args extends WorkflowArgs>(deps: WorkflowDeps): Args {
  // `deps.args` comes from CLI/runtime loading and can only be checked as the
  // base `WorkflowArgs` shape. Workflows with stricter Args are valid for
  // subworkflow calls; executing them directly relies on the caller supplying
  // matching args. Keep that unavoidable runtime trust at this single boundary
  // instead of weakening the workflow body type.
  return (deps.args ?? {}) as Args
}

// Workflow names share the cache-key alphabet so a sub name embedded into a
// step cache key like `simple-feature>plan` cannot collide with an existing
// step name. The pattern matches existing names in `examples/` (e.g.
// `simple-feature`, `ask-demo`) and rejects `>` (sub-path separator) and `:`
// (vars-hash separator).
const WORKFLOW_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/

export function workflow<Args extends WorkflowArgs = WorkflowArgs>(
  name: string,
  fn: WorkflowFn<Args>,
): WorkflowExecutor<Args> {
  if (!WORKFLOW_NAME_PATTERN.test(name)) {
    throw new Error(`workflow name must match /^[a-z0-9][a-z0-9-]*$/; got: ${JSON.stringify(name)}`)
  }
  return {
    name,
    [bodyHandle]: fn,
    async execute(deps: WorkflowDeps): Promise<void> {
      await deps.stateStore.initRun(deps.runId, {
        workflowName: deps.workflowName,
        startedAt: deps.clock.now(),
        ...(deps.args !== undefined ? { args: deps.args } : {}),
      })
      // The CLI cannot type the args at startup; treat the body's Args as
      // assignable from WorkflowArgs at the call boundary. The dual-role
      // limit (Args requiring non-prompt fields is sub-only) is documented
      // in the public guide.
      await executeWorkflowFn((run) => fn(run, argsFromDeps<Args>(deps)), deps)
    },
    async resume(deps: WorkflowDeps): Promise<void> {
      // Skip initRun() — resume validates existence and resets status directly.
      // See initRun() in FileStateStore for the execute() path.
      const state = await deps.stateStore.loadRun(deps.runId)
      if (state === undefined) throw new RunNotFoundError(deps.runId)
      if (state.status === 'completed') throw new ResumeError(deps.runId, state.status)
      await deps.stateStore.setStatus(deps.runId, 'running')
      await executeWorkflowFn((run) => fn(run, argsFromDeps<Args>(deps)), deps)
    },
  }
}
