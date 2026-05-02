import type { Runner } from '../runners/index.ts'
import type { Validator } from '../validators/index.ts'
import type { AskStepConfig } from './ask.ts'
import { setWorkflowCwd } from './execution-context.ts'
import { SchemaValidationError, type SchemaWrapper } from './schema.ts'
import type { InteractiveResult, Path, StepMode } from './types.ts'
import { type StepName, stepName } from './types.ts'
import { BUILTIN_VIEW_KINDS, isBuiltinViewKind, type PaneRole, type ViewKind } from './view.ts'
import { WorktreeResultSchema } from './worktree.ts'

// ---------------------------------------------------------------------------
// AgentStepConfig — the config stored on a Step
// ---------------------------------------------------------------------------

export interface AgentStepConfig<T = unknown> {
  readonly kind: 'agent'
  readonly agent: Runner
  readonly prompt?: string
  /**
   * Post-run assertions against the filesystem and git state. A single
   * Validator is normalized internally to a one-element array. When any
   * validator fails, the executor throws `ValidationError` — same
   * crash/resume semantics as `StepError`.
   */
  readonly validate?: Validator | ReadonlyArray<Validator>
  /** Zod schema for structured CLI output. Enables `--json-schema` and Zod validation. */
  readonly returns?: SchemaWrapper<T>
  readonly mode?: StepMode
  /**
   * Step-level view override. Wins over the runner's `defaultView.kind`.
   * Mutually exclusive with `silent: true`.
   */
  readonly view?: ViewKind
  /**
   * Step-level pane override. Wins over the runner's `defaultView.pane`.
   * Mutually exclusive with `silent: true`.
   */
  readonly pane?: PaneRole
  /**
   * Opt out of rendering entirely. The step still runs; the host never
   * receives `RunnerEvent`s for it. Lifecycle events still fire so status
   * rollups (Phase D) see `step:start` / `step:complete`.
   */
  readonly silent?: boolean
}

export interface CommitStepConfig {
  readonly kind: 'commit'
  readonly message: string
}

// ---------------------------------------------------------------------------
// PostCreate hook — runs after a worktree is created.
// ---------------------------------------------------------------------------

/**
 * Sugar form runs each line via `/bin/sh -c` with `ORIGIN`/`TARGET` env vars
 * (Windows out of scope — POSIX shell only). Callback form is the
 * cross-platform escape hatch.
 */
export type PostCreateHook = ReadonlyArray<string> | ((ctx: PostCreateCtx) => Promise<void>)

export interface PostCreateCtx {
  /** Original repo root (the cwd at the time createWorktree() ran). */
  readonly origin: Path
  /** Newly created worktree path. */
  readonly target: Path
  /**
   * Argv-only exec wrapper around ProcessService.spawn. Defaults `cwd` to
   * `target`. Rejects with `PostCreateExecError` on non-zero exit.
   */
  readonly exec: (argv: readonly string[], opts?: { readonly cwd?: Path }) => Promise<void>
}

/**
 * Thrown by the `exec` wrapper passed to a `postCreate` callback when a
 * subprocess exits non-zero. Programmatically discriminable so callbacks can
 * `catch (e) { if (e instanceof PostCreateExecError) ... }`.
 */
export class PostCreateExecError extends Error {
  readonly argv: readonly string[]
  readonly exitCode: number
  readonly stderr: string

  constructor(argv: readonly string[], exitCode: number, stderr: string) {
    super(`postCreate exec exited ${exitCode}: ${argv.join(' ')}`)
    this.name = 'PostCreateExecError'
    this.argv = argv
    this.exitCode = exitCode
    this.stderr = stderr
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export interface WorktreeStepConfig {
  readonly kind: 'worktree'
  readonly branch: string
  readonly enter: boolean
  readonly fromRef?: string
  readonly target?: string
  readonly postCreate?: PostCreateHook
}

export type StepConfig<T = unknown> =
  | AgentStepConfig<T>
  | CommitStepConfig
  | WorktreeStepConfig
  | AskStepConfig

export interface Step<T = unknown> {
  readonly name: StepName
  readonly config: StepConfig<T>
}

const RESERVED_PREFIXES: readonly string[] = ['commit:', 'worktree:', 'ask:']

// ---------------------------------------------------------------------------
// step.define — input types for the two overloads
// ---------------------------------------------------------------------------

/** Interactive overload input: mode:'interactive' forbids `returns`. */
type InteractiveStepInput = {
  readonly agent: Runner
  readonly prompt?: string
  readonly validate?: Validator | ReadonlyArray<Validator>
  readonly mode: 'interactive'
  readonly returns?: never
  readonly view?: ViewKind
  readonly pane?: PaneRole
  readonly silent?: boolean
}

/** Autonomous overload input: optional `returns` for structured output. */
type AutonomousStepInput<T> = Omit<AgentStepConfig<T>, 'kind'>

// ---------------------------------------------------------------------------
// StepFactory — overloaded define method
// ---------------------------------------------------------------------------

interface StepFactory {
  define(name: string, config: InteractiveStepInput): Step<InteractiveResult>
  define<T = unknown>(name: string, config: AutonomousStepInput<T>): Step<T>
}

function defineStep(
  name: string,
  config: InteractiveStepInput | AutonomousStepInput<unknown>,
): Step {
  for (const prefix of RESERVED_PREFIXES) {
    if (name.startsWith(prefix)) {
      const factory =
        prefix === 'commit:' ? 'commit()' : prefix === 'worktree:' ? 'createWorktree()' : 'ask()'
      throw new Error(
        `step.define() cannot use reserved prefix "${prefix}" — use the ${factory} factory instead`,
      )
    }
  }
  if (config.mode === 'interactive' && 'returns' in config && config.returns !== undefined) {
    throw new Error(
      `step.define("${name}"): interactive steps cannot have "returns:" — ` +
        'structured output is not available in interactive mode',
    )
  }
  assertViewFieldsValid(name, config)
  return Object.freeze({ name: stepName(name), config: { kind: 'agent' as const, ...config } })
}

function assertViewFieldsValid(
  name: string,
  config: InteractiveStepInput | AutonomousStepInput<unknown>,
): void {
  if (config.silent === true && (config.view !== undefined || config.pane !== undefined)) {
    throw new Error(
      `step.define("${name}"): silent:true is mutually exclusive with view/pane — ` +
        'pick either "silent:true" or a view/pane override',
    )
  }
  if (config.view !== undefined && !isBuiltinViewKind(config.view)) {
    throw new Error(
      `step.define("${name}"): unknown view "${config.view}"; ` +
        `expected one of ${BUILTIN_VIEW_KINDS.join(' | ')}`,
    )
  }
}

export const step: StepFactory = {
  define: defineStep as StepFactory['define'],
}

// ---------------------------------------------------------------------------
// onCacheHit — kind-agnostic cache-hit dispatch
// ---------------------------------------------------------------------------
//
// Replay returns the cached value without running the body, but some kinds
// have a side-effect to reapply: agent steps re-validate the cached value
// against the (possibly updated) schema; worktree steps with `enter: true`
// must reapply the ALS cwd switch so subsequent run() calls observe the
// right cwd. Commit is a no-op. The dispatcher stays kind-agnostic by shape;
// the exhaustive switch lives here.

export function onCacheHit(config: StepConfig, key: StepName, cachedValue: unknown): void {
  switch (config.kind) {
    case 'agent': {
      if (config.returns === undefined) return
      const parsed = config.returns.zodSchema.safeParse(cachedValue)
      if (!parsed.success) throw new SchemaValidationError(key, parsed.error)
      return
    }
    case 'commit':
      return
    case 'worktree': {
      const parsed = WorktreeResultSchema.safeParse(cachedValue)
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => i.message).join(', ')
        throw new Error(`worktree cache entry "${key}" is malformed: ${issues}`)
      }
      const requestedFrom = config.fromRef ?? 'HEAD'
      if (parsed.data.branch !== config.branch || parsed.data.fromRef !== requestedFrom) {
        throw new Error(
          `createWorktree: step "${key}" is cached with branch "${parsed.data.branch}" / from "${parsed.data.fromRef}"; ` +
            `current call requested branch "${config.branch}" / from "${requestedFrom}". ` +
            `Two different branches sanitized to the same step name. Use distinct names.`,
        )
      }
      if (!config.enter) return
      // Safe cast: schema requires a non-empty string and the value originated
      // from a `Path` write to state.json by the worktree executor.
      setWorkflowCwd(parsed.data.path as Path)
      return
    }
    case 'ask':
      // No-op on cache replay. Cached value is `AskResult`; no schema to
      // re-validate. Definition-vs-cache drift (button removed, field
      // renamed) is detected separately by `isAskCacheValid` BEFORE
      // `runStepOnce` reaches the cache-hit branch — mismatch downgrades the
      // hit to a miss without throwing. NO sentinel exception.
      return
    default: {
      const _exhaustive: never = config
      throw new Error(`Unexpected step kind: ${JSON.stringify(_exhaustive)}`)
    }
  }
}
