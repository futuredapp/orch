# Authoring API reference

Everything in this page is exported from the `orch` package barrel:

```ts
import { workflow, step, commit, createWorktree, ask, command } from 'orch'
import { claude, codex } from 'orch'
import { fileProduced, gitDiffCreated, gitCommitCreated, check, defineValidator } from 'orch'
import { schema, z } from 'orch'
```

`z` is Zod, re-exported so workflows can declare schemas without adding `zod` to their own dependencies.

## workflow

```ts
function workflow(name: string, fn: (run: RunFn, args: WorkflowArgs) => Promise<void>): WorkflowExecutor
```

Wraps a workflow function and returns a `WorkflowExecutor`. The orch CLI loads the default export, so a workflow file ends with:

```ts
export default workflow('feature', async (run, args) => {
  // args.prompt is the inline prompt from `orch run feature "..."`, if any.
  await run(SOME_STEP)
})
```

- `run` — the [`run()`](#run) primitive (below).
- `args` — `{ prompt?: string }`, supplied by the CLI's inline prompt or `--prompt`.

## run

`run` is passed into your workflow function; you do not import it. It invokes a step and returns its typed result.

```ts
interface RunFn {
  <T, V>(step: Step<T, V>, overrides: RunOverrides<V> & { mode: 'interactive' }): Promise<InteractiveResult>
  <T, V>(step: Step<T, V>, overrides?: RunOverrides<V>): Promise<T>
}

type RunOverrides<V = PromptVars> = {
  readonly as?: string              // memoize under a different name
  readonly prompt?: string          // replace the step's default prompt (bypasses substitution)
  readonly extraContext?: JsonValue // JSON appended to the prompt (serialized)
  readonly extraPrompt?: string     // text appended after the prompt
  readonly mode?: 'interactive' | 'autonomous'
  readonly vars: V                  // required when V has required keys; optional otherwise
}
```

```ts
const plan = await run(PLAN, { prompt: 'Plan the auth refactor' })
await run(WORK, { as: 'work-auth', prompt: 'Implement auth' })
await run(WORK, { as: 'work-api', prompt: 'Implement the API' })

// Typed vars: the same step reused with different inputs.
const GREET = step.define('greet', { agent, prompt: 'Hi {{name}}' })
await run(GREET, { vars: { name: 'Ada'   } })
await run(GREET, { vars: { name: 'Boris' } })
```

Two `run()` calls with different `vars` produce distinct cache entries; the same vars on a second call hits the cache. Setting `as:` explicitly overrides the cache name (no vars hash is appended). Inside a subworkflow, `as:` also bypasses the automatic sub-path prefix, so use it only when you intentionally want a flat, shared cache key. See [Typed prompt vars](../guides/typed-prompt-vars) for the full compile-time contract.

Forcing `mode: 'interactive'` changes the return type to `InteractiveResult` (`{ exitCode, durationMs, sessionId }`).

## step.define

```ts
// Inline literal prompt — TVars inferred from the `{{placeholder}}` tokens.
step.define(name, { agent, prompt: 'Hi {{name}}' }): Step<…, { name: string | number | boolean }>

// Prompt file — TVars looked up from PromptFileRegistry (populated by `orch types`).
step.define(name, { agent, promptFile: '@/.orch/prompts/x.md' }): Step<…, PromptFileRegistry['@/.orch/prompts/x.md']>

// No placeholders — defaults to the no-vars sentinel `Record<string, never>`,
// which rejects any `vars` at the call site.
step.define(name, { agent, prompt: 'no placeholders' }): Step<…, Record<string, never>>
```

Declares a reusable **agent step**. `name` is the memoization key. `TVars` is **inferred** — do not pass it explicitly. Three paths:

- inline `prompt: 'Hi {{name}}'` literals — extracted via TypeScript's template-literal types (the `<const T>` modifier preserves the literal without `as const`)
- `promptFile: '@/...'` paths — looked up in the [`PromptFileRegistry`](#promptfileregistry) augmentation `orch types` writes per file
- no placeholders — `Record<string, never>` sentinel, which rejects extra `vars` at the call site

::: warning
Do not pass `TVars` explicitly: `step.define<…, { x: string }>(…)` short-circuits the inference and silently widens to whatever you wrote. Let the compiler derive it from the prompt or `PromptFileRegistry` lookup.
:::

```ts
import { step, claude, schema, z, fileProduced } from 'orch'

const PLAN = step.define('plan', {
  agent: claude({ model: 'claude-opus-4-7' }),
  prompt: 'Draft an implementation plan.',
  returns: schema(z.object({ phases: z.array(z.string()) })),
  validate: fileProduced('docs/plans/*.md'),
})
```

`AgentStepConfig` fields:

| Field | Type | Notes |
| --- | --- | --- |
| `agent` | `Runner` | Required. From `claude()`, `codex()`, or `defineRunner(...)`. |
| `prompt` | `string` | Default prompt; overridable per call. Mutually exclusive with `promptFile`. |
| `promptFile` | `string` | Path to a sibling `.md` file holding the prompt text. Resolves against the declaring workflow's directory, or against the orch project root if it starts with `@/`. The file is read at `step.define` time; substitution happens per `run()` call. See [File-based prompts](../guides/file-based-prompts). |
| `returns` | `SchemaWrapper<T>` | A `schema(zod)` for structured output. Enables `--json-schema` and Zod validation. Not allowed on interactive steps. |
| `validate` | `Validator \| Validator[]` | Post-run assertions; all must pass. See [Validators](#validators). |
| `mode` | `'interactive' \| 'autonomous'` | Default `'autonomous'`. |
| `view` | `ViewKind` | Step-level render override (two-pane). Mutually exclusive with `silent`. |
| `pane` | `'left' \| 'right'` | Pane override (two-pane). Mutually exclusive with `silent`. |
| `silent` | `boolean` | Run the step but render nothing. Logs still capture. |
| `autoStop` | `boolean` | Interactive-only: auto-close the pane when the agent finishes its turn. Requires a runner with `prepareAutoStop`. Setting it on an autonomous step is a definition-time error. |
| `recovery` | `RecoveryStrategy` | Autonomous-only: how to handle a transient terminal API failure. `backoffResume()` (the default) waits, forks the session from the last clean checkpoint, sends one nudge, and watches for progress, bounded by an attempt ceiling and a wall-clock cap; `noRetry()` fails fast (pre-recovery behavior). Precedence: step option > workflow default (`WorkflowDeps.recovery`) > built-in `backoffResume()`. Setting it on a non-agent step is a definition-time error. Import `noRetry` / `backoffResume` from `orch`. |

::: tip Interactive steps cannot declare `returns`
Structured output is unavailable in interactive mode — `step.define` throws at definition time if you combine `mode: 'interactive'` with `returns`.
:::

## PromptFileRegistry

```ts
interface PromptFileRegistry {}
```

An intentionally empty interface declared in orch. Generated `.d.ts` sidecars (one per discovered prompt file) augment it via `declare module 'orch'` so `step.define({ promptFile: '@/...' })` recovers a typed `vars` contract:

```ts
// AUTO-GENERATED by `orch types` — do not edit.
declare module 'orch' {
  interface PromptFileRegistry {
    '@/.orch/prompts/brainstorm.md': {
      topic: string | number | boolean
      depth?: string | number | boolean
    }
  }
}
export {}
```

Sidecars are generated by the `orch types` command (one-shot) or `orch types --watch` (regen-on-save). `orch run` runs the same generator at startup so cold clones work without setup. See [Typed prompt vars](../guides/typed-prompt-vars) for the end-to-end flow.

## VarsOf

```ts
type VarsOf<T extends string>
```

Type-level extractor that produces the inferred `vars` contract for a literal prompt string. Authors rarely use it directly — `step.define` returns the right `Step<TResult, TVars>` automatically — but it's exported from `'orch'` for downstream helpers and generic utilities.

## loadPrompt

```ts
function loadPrompt(path: string, vars?: Readonly<Record<string, string | number | boolean>>): string
```

Synchronously read a prompt fragment, substitute `{{var}}` placeholders, and return the result as a string. Use it to compose two or more fragments into the existing `prompt:` field.

```ts
import { loadPrompt, step } from 'orch'

const intro = loadPrompt('intro.md', { topic: 'auth' })
const ctx   = loadPrompt('@/.orch/prompts/session-context.md', { sessionsDir })

const RESEARCH = step.define('research', {
  agent: AUTONOMOUS,
  prompt: `${intro}\n\n${ctx}`,
})
```

Path resolution and substitution semantics are identical to `promptFile:` on `step.define`. A path starting with `@/` resolves against the orch project root (the directory containing `orch.config.ts` or `.orch/orch.config.ts`); any other path resolves against the workflow file's directory. Paths escaping the project root are rejected.

Throws `PromptFileError` synchronously at the call site for traversal, missing file, missing placeholder, unused key, or unsupported `vars` type.

For a single file with no composition, prefer `promptFile:` directly — it carries the same semantics with less ceremony.

## ask

```ts
function ask<F extends AskFields, const B extends string>(input: AskInput<F, B>): Step<AskResult<F, B>>
```

A step that prompts the human for input and returns a typed, discriminated result.

```ts
const ASK_CONTINUE = ask({
  name: 'continue',
  question: 'Continue?',
  fields: { notes: { placeholder: 'optional' } },
  buttons: ['continue', 'retry', 'abort'],
  defaultWhenNoninteractive: { button: 'continue' },
})

const r = await run(ASK_CONTINUE)
if (!r.cancelled) {
  r.button // 'continue' | 'retry' | 'abort'
  r.notes  // string
}
```

`AskInput` fields:

| Field | Type | Notes |
| --- | --- | --- |
| `name` | `string` | Slugified into the step name (`ask:<slug>`). |
| `question` | `string` | The prompt shown to the user. |
| `fields` | `{ [name]: { placeholder?: string } }` | Optional text inputs. Field keys must match `^[a-zA-Z][a-zA-Z0-9_]*$`. |
| `buttons` | `readonly B[]` | The choices. The chosen one is returned as a narrowed literal. |
| `defaultWhenNoninteractive` | `{ cancelled: true } \| { button: B, ...fields }` | Used under `--noninteractive`. Without it, an `ask()` errors in that mode. |

The result is `{ cancelled: true, fields: Partial<...> }` or `{ cancelled: false, button: B, ...fields }`.

## command

```ts
function command(name: string, opts: CommandOpts): Step<CommandResult>
```

Runs an arbitrary shell command as a first-class, streamed, memoized step.

```ts
const TEST = command('test', { argv: ['bun', 'test'], onFailure: 'halt' })

const result = await run(TEST)
result.exitCode // number
result.stdout   // string
```

`CommandOpts`:

| Field | Type | Notes |
| --- | --- | --- |
| `argv` | `readonly string[]` | Required. The command and its arguments. |
| `onFailure` | `'halt' \| 'continue'` | Required. `halt` throws on non-zero exit; `continue` returns the result. |
| `cwd` | `Path` | Working directory. Defaults to the workflow cwd. |
| `env` | `Record<string, string>` | Extra environment variables. |
| `pane` | `'left' \| 'right'` | Output pane (two-pane). Default `'right'`. |
| `silent` | `boolean` | Suppress host output; logs still capture. |

Returns `CommandResult`: `{ exitCode, stdout, stderr, durationMs }`.

## commit

```ts
function commit(message: string): Step<CommitResult | null>
```

Stages all changes and creates a git commit. Returns `{ sha }`, or `null` when the working tree was already clean (natural on resume).

```ts
await run(WORK, { as: 'work-auth' })
await run(commit('feat(auth): extract token service'))
```

::: warning `git add .` stages everything
A commit step stages every change in the working tree, including any secrets an agent may have written (`.env`, `*.pem`). Review what your steps produce.
:::

## createWorktree

```ts
function createWorktree(branch: string, opts: CreateWorktreeOpts): Step<WorktreeResult>
```

Materializes a git worktree as a memoizable step. With `enter: true`, the workflow's cwd switches into the new worktree, so every subsequent `run()` and `commit()` lands inside it.

```ts
await run(createWorktree('feat/foo', {
  enter: true,
  from: 'main',                          // optional; defaults to HEAD
  postCreate: ['cp $ORIGIN/.env .', 'bun install'],
}))
await run(IMPLEMENT)               // runs inside the new worktree
await run(commit('feat: done'))    // commits inside the new worktree
```

`CreateWorktreeOpts`:

| Field | Type | Notes |
| --- | --- | --- |
| `enter` | `boolean` | Required. `true` switches the workflow cwd into the worktree. |
| `from` | `string` | Base ref. Defaults to `HEAD`. |
| `target` | `string` | `'sibling'` (default), or a relative/absolute path. |
| `postCreate` | `string[] \| (ctx) => Promise<void>` | Shell lines (run via `/bin/sh -c` with `$ORIGIN`/`$TARGET`) or a callback. |

Returns `WorktreeResult`: `{ path, branch, fromRef }`. Inside [`parallel()`](#parallel), only the homogeneous form is valid for `enter: true`.

## parallel

```ts
// Heterogeneous — different steps at once, returns a typed tuple
function parallel<T>(branches: readonly Promise<T>[]): Promise<T[]>

// Homogeneous — same step mapped over inputs, with optional concurrency cap
function parallel<I, T>(
  items: readonly I[],
  fn: (item: I) => Promise<T>,
  opts?: { concurrency?: number },
): Promise<T[]>
```

```ts
// Heterogeneous
const [a, b] = await parallel([
  run(RESEARCH_CLAUDE, { prompt: 'Approach A' }),
  run(RESEARCH_CODEX, { prompt: 'Approach B' }),
])

// Homogeneous
const reviews = await parallel(
  ['security', 'performance', 'design'],
  (lens) => run(REVIEW, { as: `review-${lens}`, prompt: `Review for ${lens}` }),
  { concurrency: 2 },
)
```

Each branch gets a stable memoization key, so a parallel block is individually resumable. Interactive steps cannot run inside `parallel()`.

`runWorkflow(...)` is supported only in the homogeneous `parallel(items, fn)` form. The heterogeneous array form eagerly creates promises before `parallel()` owns a branch frame, so `parallel([runWorkflow(a, args), runWorkflow(b, args)])` is unsupported in v1.

::: warning Don't parallelize ordered work
`parallel()` is for genuinely independent work. Sequential, dependent steps belong in a plain `for` loop.
:::

## runWorkflow

```ts
function runWorkflow<Args extends WorkflowArgs>(
  executor: WorkflowExecutor<Args>,
  args: Args,
): Promise<void>
```

Invokes a subworkflow's body inline, sharing the parent's `runId`, state store, log directory, and captureLock. Pushes a fresh sub-frame so the sub's `setWorkflowCwd(...)` / `createWorktree({ enter: true })` cannot leak back to the parent. Emits `subworkflow:enter` before the sub body runs and `subworkflow:exit` (with `outcome: 'completed' | 'failed'`) after it resolves or rejects.

```ts
import { runWorkflow, workflow } from 'orch'
import simpleFeature from '../simple-feature/index.ts'

export default workflow('feature', async (_run, args) => {
  await runWorkflow(simpleFeature, { prompt: args.prompt ?? '' })
})
```

Sub-internal step names are persisted under a namespaced cache key (`<sub>>name`) so two subs with overlapping step names can run from the same parent without colliding. User-authored workflow names must match `^[a-z0-9][a-z0-9-]*$`; `:` and `>` are reserved for generated step/cache keys.

Inside `parallel()`, call subworkflows only from the homogeneous `parallel(items, fn)` form:

```ts
await parallel([{ sub: shipA }, { sub: shipB }], async (branch) => {
  await runWorkflow(branch.sub, { prompt: args.prompt ?? '' })
})
```

The heterogeneous form `parallel([runWorkflow(a, args), runWorkflow(b, args)])` is unsupported in v1 because those `runWorkflow(...)` calls enter before `parallel()` can create branch-local execution context.

::: warning v1 — single invocation per sub per run
A sub can be invoked at most once per parent run. A second invocation throws `StepNameCollisionError`. For "the same sequence N times", use N distinct subs (see [Subworkflows guide](/guides/subworkflows#single-invocation-limit-v1)).
:::

Depth-bound: chains over `WorkflowDeps.maxSubworkflowDepth` (default `8`) throw `SubworkflowDepthError` before invoking the sub. Override per execution by setting `maxSubworkflowDepth` on the deps object.

## workflow (generic Args)

`workflow(...)` is generic over the body's `Args` type, constrained to extend `WorkflowArgs`:

```ts
function workflow<Args extends WorkflowArgs = WorkflowArgs>(
  name: string,
  fn: WorkflowFn<Args>,
): WorkflowExecutor<Args>

interface WorkflowArgs {
  readonly prompt?: string
}
```

```ts
interface ReviewArgs extends WorkflowArgs {
  readonly prompt: string
  readonly lens: 'security' | 'performance' | 'design'
}

export default workflow<ReviewArgs>('review', async (run, args) => {
  await run(REVIEW, { vars: { lens: args.lens, prompt: args.prompt } })
})
```

The default `Args = WorkflowArgs` keeps every existing top-level workflow source-compatible.

Workflow names must be lowercase kebab-case: `^[a-z0-9][a-z0-9-]*$`. Step names share the same lowercase-first style but generated cache keys may also contain `:` and `>` internally, with a 512-character cap to accommodate sub-path prefixes.

## schema

```ts
function schema<T>(zodSchema: ZodType<T>): SchemaWrapper<T>
```

Wraps a Zod schema for use in a step's `returns:`. orch passes the JSON Schema to the agent (`--json-schema` for Claude, `--output-schema` for Codex), then validates and types the result.

```ts
import { schema, z } from 'orch'

const PLAN = step.define('plan', {
  agent: claude(),
  returns: schema(z.object({
    phases: z.array(z.object({ name: z.string(), riskLevel: z.enum(['low', 'high']) })),
  })),
})

const plan = await run(PLAN) // typed: plan.phases[number].riskLevel
```

## Validators

Passed to a step's `validate:`. They run after the agent exits; any failure throws and halts the workflow (same crash/resume semantics as a step error).

```ts
function fileProduced(glob: string): Validator      // at least one file matches
function gitDiffCreated(): Validator                // non-empty diff since step start
function gitCommitCreated(): Validator               // HEAD moved forward
function check(fn: (ctx: ValidatorCtx) => ...): Validator           // inline one-off
function defineValidator(name: string, fn: (ctx) => ...): Validator // reusable, named
```

```ts
import { fileProduced, gitCommitCreated, check, defineValidator } from 'orch'

const testsPassed = defineValidator('tests-passed', async (ctx) => {
  const { exitCode } = await ctx.exec('bun test')
  return exitCode === 0 ? ok() : fail('tests failed')
})

const WORK = step.define('work', {
  agent: claude(),
  validate: [
    fileProduced('src/**/*.ts'),
    gitCommitCreated(),
    check((ctx) => (ctx.value ? true : 'expected a return value')),
    testsPassed(),
  ],
})
```

A `check`/`defineValidator` function receives a `ValidatorCtx` (step name, cwd, the parsed `returns` value, and an `exec` helper) and returns `ok()` / `fail(reason)` (or `true` / a string).

## Execution-context helpers

For advanced workflows that change directory or inspect nesting:

| Function | Returns | Notes |
| --- | --- | --- |
| `currentCwd(fallback)` | `Path` | The workflow's current cwd (changes after `createWorktree({ enter: true })`). |
| `setWorkflowCwd(path)` | `void` | Switch the cwd for subsequent steps. |
| `currentParallelDepth()` | `number` | Nesting level inside `parallel()`. |
| `executionContext()` | context | The current execution-context store. |

## StateStore

The persistence port behind a run's state directory. Most workflows never touch it directly, but it is exported from `orch` for tools that need to locate a run's on-disk artifacts.

```ts
runDir(runId: RunId): Path
```

Returns the absolute directory this store reads and writes for a run (`<basePath>/<runId>`). A pure path computation — no I/O, and it does not imply the directory exists.

```ts
import { FileStateStore } from 'orch'

const store = new FileStateStore({ fs, basePath })
const dir = store.runDir(runId) // e.g. <basePath>/<runId>
```

## Where to go next

- [Runners](/reference/runners) — `claude()`, `codex()`, and writing your own.
- [CLI](/reference/cli) — commands, flags, and exit codes.
- [Configuration](/reference/config) — `orch.config.ts` and environment variables.
