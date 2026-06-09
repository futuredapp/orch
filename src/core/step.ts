import type { Runner } from '../runners/index.ts'
import type { Validator } from '../validators/index.ts'
import type { AskStepConfig } from './ask.ts'
import type { CommandStepConfig } from './command.ts'
import { CommandResultSchema } from './command.ts'
import { setWorkflowCwd } from './execution-context.ts'
import { callerDir } from './prompt-file/caller-dir.ts'
import { PromptFileError } from './prompt-file/errors.ts'
import { getPromptFileReader } from './prompt-file/prompt-file-reader.ts'
import type { PromptFileRegistry } from './prompt-file/registry.ts'
import { resolvePromptPath } from './prompt-file/resolve-prompt-path.ts'
import type { PromptVars, PromptVarsBound } from './prompt-file/substitute.ts'
import type { VarsOf } from './prompt-file/template-vars.ts'
import type { RecoveryStrategy } from './recovery/index.ts'
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
  /**
   * Interactive-only opt-in: when `true`, orch injects a per-run, signal-only
   * stop hook into the agent CLI and closes the pane automatically when the
   * agent finishes a turn — so an unattended pipeline doesn't stall on a
   * finished-but-idle step waiting for a human. Default `false`. Setting it on
   * an autonomous step is a definition-time error (autonomous steps already
   * self-terminate). Requires a runner with the `prepareAutoStop` capability,
   * or the executor fails fast with `AutoStopUnsupportedError`.
   */
  readonly autoStop?: boolean
  /**
   * Autonomous-only error-recovery strategy (R14). Defaults to
   * `backoffResume()` when unset; opt out with `recovery: noRetry()`. A
   * workflow-level default (`WorkflowDeps.recovery`) sits between the two.
   * Setting it on an interactive step is a definition-time error — interactive
   * recovery is a separate Phase 2 capability.
   */
  readonly recovery?: RecoveryStrategy
  /**
   * The resolved absolute path of the prompt file used to build `prompt`,
   * when the step was authored with `promptFile:`. Kept for observability
   * (log lines that name the source file). Never read by executors.
   */
  readonly promptFile?: Path
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
  | CommandStepConfig

/**
 * `Step<TResult, TVars>` — the public step shape.
 *
 * - `TResult` is the value `run(STEP, ...)` resolves to.
 * - `TVars` is the typed `vars:` contract for that step. The default
 *   `Record<never, never>` means "no vars accepted" (extra keys at the call
 *   site become compile errors), which is what an author wants for a step
 *   without `{{placeholder}}` tokens. `TVars` never appears on the runtime
 *   config — it exists purely at the type level so `RunFn` / `RunOverrides`
 *   can carry it from `step.define` to every `run(STEP, ...)` site.
 */
export interface Step<TResult = unknown, TVars extends PromptVarsBound = Record<string, never>> {
  readonly name: StepName
  readonly config: StepConfig<TResult>
  // `TVars` is phantom — referenced here so the generic isn't structurally
  // discarded. Authors never read it; `RunFn` does.
  /** @internal */
  readonly _vars?: TVars
}

const RESERVED_PREFIXES: readonly string[] = ['commit:', 'worktree:', 'ask:', 'command:']

const RESERVED_FACTORIES: Readonly<Record<string, string>> = {
  'commit:': 'commit()',
  'worktree:': 'createWorktree()',
  'ask:': 'ask()',
  'command:': 'command()',
}

// ---------------------------------------------------------------------------
// step.define — input types for the two overloads
// ---------------------------------------------------------------------------

/** Interactive overload input: mode:'interactive' forbids `returns`. */
type InteractiveStepInput = {
  readonly agent: Runner
  readonly prompt?: string
  readonly promptFile?: string
  /**
   * `vars:` is rejected at `step.define` time — vars belong on the per-call
   * `run(STEP, { vars })` override site so the typed contract flows through
   * the registry lookup, not on the static step definition. Typing this as
   * `never` makes the type checker reject it as a static error; the runtime
   * guard at `assertPromptFieldsValid` still throws `PromptFileError`
   * (cause: 'vars-on-define') as a backup for non-TS callers.
   */
  readonly vars?: never
  readonly validate?: Validator | ReadonlyArray<Validator>
  readonly mode: 'interactive'
  readonly returns?: never
  readonly view?: ViewKind
  readonly pane?: PaneRole
  readonly silent?: boolean
  readonly autoStop?: boolean
}

/** Autonomous overload input: optional `returns` for structured output. */
type AutonomousStepInput<T> = Omit<AgentStepConfig<T>, 'kind' | 'promptFile'> & {
  readonly promptFile?: string
  /** See note on `InteractiveStepInput.vars` — vars-on-define is a type error. */
  readonly vars?: never
}

// ---------------------------------------------------------------------------
// PromptVarsFromFile — registry lookup with a safe fallback
//
// When the codegen step (U7) has emitted a sidecar for `TPath`, the augmented
// `PromptFileRegistry` carries the typed contract and we lift it through.
// When no augmentation exists (mid-codegen state, or a fresh clone before
// `orch types` has run), `keyof PromptFileRegistry` is `never` and we widen
// to `PromptVars` so `vars:` is permissive at the call site. Runtime
// substitution still enforces the actual placeholder set.
// ---------------------------------------------------------------------------

type PromptVarsFromFile<TPath extends string> = TPath extends keyof PromptFileRegistry
  ? PromptFileRegistry[TPath] extends PromptVarsBound
    ? PromptFileRegistry[TPath]
    : PromptVars
  : PromptVars

// ---------------------------------------------------------------------------
// StepFactory — overloaded define method
//
// Six overloads, ordered most-specific-first:
//   1. Interactive + inline literal `prompt: T` → TVars inferred via VarsOf<T>.
//   2. Autonomous  + inline literal `prompt: T` → TVars inferred via VarsOf<T>.
//   3. Interactive + `promptFile:`              → TVars widened to PromptVars.
//   4. Autonomous  + `promptFile:`              → TVars widened to PromptVars.
//   5. Interactive (no `prompt:` literal, no `promptFile:`).
//   6. Autonomous  (no `prompt:` literal, no `promptFile:`).
//
// `<const T extends string>` is the TS 5.0+ const modifier that preserves the
// literal type of `prompt:` WITHOUT requiring authors to write `as const` at
// the call site. The promptFile branch is widened to `PromptVars` here; U5
// tightens it via `PromptFileRegistry[TPath]` lookup.
// ---------------------------------------------------------------------------

interface StepFactory {
  // (1) Interactive + inline literal
  define<const T extends string>(
    name: string,
    config: InteractiveStepInput & { readonly prompt: T },
  ): Step<InteractiveResult, VarsOf<T>>
  // (2) Autonomous + inline literal
  define<TResult = unknown, const T extends string = string>(
    name: string,
    config: AutonomousStepInput<TResult> & { readonly prompt: T },
  ): Step<TResult, VarsOf<T>>
  // (3) Interactive + promptFile literal — TVars resolves via
  //     `PromptFileRegistry[TPath]` if the sidecar has been generated for that
  //     path; falls back to `PromptVars` otherwise (mid-codegen state).
  define<const TPath extends string>(
    name: string,
    config: InteractiveStepInput & { readonly promptFile: TPath },
  ): Step<InteractiveResult, PromptVarsFromFile<TPath>>
  // (4) Autonomous + promptFile literal — same registry-lookup shape.
  define<TResult = unknown, const TPath extends string = string>(
    name: string,
    config: AutonomousStepInput<TResult> & { readonly promptFile: TPath },
  ): Step<TResult, PromptVarsFromFile<TPath>>
  // (5) Interactive (no literal, no promptFile)
  define(name: string, config: InteractiveStepInput): Step<InteractiveResult>
  // (6) Autonomous (no literal, no promptFile)
  define<TResult = unknown>(name: string, config: AutonomousStepInput<TResult>): Step<TResult>
}

function defineStep(
  name: string,
  config: InteractiveStepInput | AutonomousStepInput<unknown>,
): Step {
  for (const prefix of RESERVED_PREFIXES) {
    if (name.startsWith(prefix)) {
      const factory = RESERVED_FACTORIES[prefix] ?? 'the matching factory'
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
  if (config.autoStop === true && config.mode !== 'interactive') {
    throw new Error(
      `step.define("${name}"): autoStop:true is only valid on interactive steps — ` +
        'autonomous steps self-terminate, so there is no idle turn to auto-stop',
    )
  }
  if ('recovery' in config && config.recovery !== undefined && config.mode === 'interactive') {
    throw new Error(
      `step.define("${name}"): recovery is only valid on autonomous agent steps — ` +
        'interactive recovery is a separate Phase 2 capability',
    )
  }
  assertPromptFieldsValid(name, config)
  assertViewFieldsValid(name, config)
  const resolved = resolvePromptFile(name, config)
  return Object.freeze({
    name: stepName(name),
    config: { kind: 'agent' as const, ...resolved } satisfies AgentStepConfig<unknown>,
  })
}

function assertPromptFieldsValid(
  name: string,
  config: InteractiveStepInput | AutonomousStepInput<unknown>,
): void {
  if (config.promptFile !== undefined && config.prompt !== undefined) {
    throw new PromptFileError(
      `step.define("${name}"): cannot set both "prompt" and "promptFile" — pick one`,
      { cause: 'mutex', stepName: name, promptFile: config.promptFile },
    )
  }
  if (config.vars !== undefined) {
    throw new PromptFileError(
      `step.define("${name}"): "vars" is no longer allowed on define — ` +
        'move vars to run(STEP, { vars: ... }) for typed per-call injection. ' +
        'See docs/public/guides/typed-prompt-vars.md for migration recipe.',
      {
        cause: 'vars-on-define',
        stepName: name,
        ...(config.promptFile !== undefined ? { promptFile: config.promptFile } : {}),
      },
    )
  }
}

// Resolve a `promptFile` into the existing `prompt:` field. Returns a copy of
// the input config with the raw file template on `prompt` and the resolved
// `promptFile` path retained (observability). `vars` no longer exists on the
// input under R23 — it lives exclusively on `RunOverrides`, so substitution
// happens at `assemblePrompt` time instead of here. When no `promptFile` is
// given, returns the input unchanged.
type ResolvedAgentInput = Omit<AgentStepConfig<unknown>, 'kind'>

function resolvePromptFile(
  name: string,
  config: InteractiveStepInput | AutonomousStepInput<unknown>,
): ResolvedAgentInput {
  if (config.promptFile === undefined) {
    const { vars: _vars, promptFile: _pf, ...rest } = config
    return rest as ResolvedAgentInput
  }
  const promptFileInput = config.promptFile
  const dir = callerDir(defineStep)
  const reader = getPromptFileReader()
  const resolved = resolvePromptPath(promptFileInput, dir, reader.projectRoot())
  let template: string
  try {
    template = reader.readSync(resolved)
  } catch (e) {
    if (e instanceof PromptFileError) {
      throw new PromptFileError(`step.define("${name}"): ${e.message}`, {
        cause: e.cause,
        stepName: name,
        promptFile: resolved,
      })
    }
    throw e
  }
  if (template.trim().length === 0) {
    throw new PromptFileError(
      `step.define("${name}"): promptFile "${promptFileInput}" is empty — ` +
        'prompt templates must contain at least one non-whitespace character',
      { cause: 'empty-prompt', stepName: name, promptFile: resolved },
    )
  }
  const { vars: _vars, promptFile: _pf, prompt: _p, ...rest } = config
  return { ...rest, prompt: template, promptFile: resolved } as ResolvedAgentInput
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
    case 'command': {
      const parsed = CommandResultSchema.safeParse(cachedValue)
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => i.message).join(', ')
        throw new Error(`command cache entry "${key}" is malformed: ${issues}`)
      }
      // Side effects already happened on the original run; resume just
      // returns the cached value. Authors who want a real rerun pass `as:`
      // with a unique suffix or wipe the state entry.
      return
    }
    default: {
      const _exhaustive: never = config
      throw new Error(`Unexpected step kind: ${JSON.stringify(_exhaustive)}`)
    }
  }
}
