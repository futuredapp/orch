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
  <T>(step: Step<T>, overrides: RunOverrides & { mode: 'interactive' }): Promise<InteractiveResult>
  <T>(step: Step<T>, overrides?: RunOverrides): Promise<T>
}

interface RunOverrides {
  readonly as?: string          // memoize under a different name
  readonly prompt?: string      // replace the step's default prompt
  readonly extraContext?: JsonValue  // JSON appended to the prompt (serialized)
  readonly extraPrompt?: string // text appended after the prompt
  readonly mode?: 'interactive' | 'autonomous'
}
```

```ts
const plan = await run(PLAN, { prompt: 'Plan the auth refactor' })
await run(WORK, { as: 'work-auth', prompt: 'Implement auth' })
await run(WORK, { as: 'work-api', prompt: 'Implement the API' })
```

Forcing `mode: 'interactive'` changes the return type to `InteractiveResult` (`{ exitCode, durationMs, sessionId }`).

## step.define

```ts
step.define(name: string, config: AgentStepConfig): Step
```

Declares a reusable **agent step**. `name` is the memoization key.

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
| `prompt` | `string` | Default prompt; overridable per call. |
| `returns` | `SchemaWrapper<T>` | A `schema(zod)` for structured output. Enables `--json-schema` and Zod validation. Not allowed on interactive steps. |
| `validate` | `Validator \| Validator[]` | Post-run assertions; all must pass. See [Validators](#validators). |
| `mode` | `'interactive' \| 'autonomous'` | Default `'autonomous'`. |
| `view` | `ViewKind` | Step-level render override (two-pane). Mutually exclusive with `silent`. |
| `pane` | `'left' \| 'right'` | Pane override (two-pane). Mutually exclusive with `silent`. |
| `silent` | `boolean` | Run the step but render nothing. Logs still capture. |
| `autoStop` | `boolean` | Interactive-only: auto-close the pane when the agent finishes its turn. Requires a runner with `prepareAutoStop`. Setting it on an autonomous step is a definition-time error. |

::: tip Interactive steps cannot declare `returns`
Structured output is unavailable in interactive mode — `step.define` throws at definition time if you combine `mode: 'interactive'` with `returns`.
:::

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

::: warning Don't parallelize ordered work
`parallel()` is for genuinely independent work. Sequential, dependent steps belong in a plain `for` loop.
:::

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

## Where to go next

- [Runners](/reference/runners) — `claude()`, `codex()`, and writing your own.
- [CLI](/reference/cli) — commands, flags, and exit codes.
- [Configuration](/reference/config) — `orch.config.ts` and environment variables.
