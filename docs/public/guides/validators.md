# Validators

> **What you'll learn:** how to assert that a step actually produced what it promised, with built-in validators, inline checks, and reusable named ones.

An agent can exit cleanly without doing the job — it says "done" but the file isn't there, or the diff is empty. A validator runs *after* the agent exits and turns "claims to be done" into "verified done." A failing validator fails the step, with the same crash/resume semantics as any step error.

## Built-in validators

Three cover the common cases. Pass them to a step's `validate:`:

```ts
import { step, claude } from 'orch'
import { fileProduced, gitDiffCreated, gitCommitCreated } from 'orch'

const WORK = step.define('work', {
  agent: claude(),
  validate: gitDiffCreated(), // fails unless the working tree changed
})
```

| Validator | Passes when |
| --- | --- |
| `fileProduced(glob)` | At least one file matches the glob after the step. |
| `gitDiffCreated()` | The working tree has a non-empty diff since the step started. |
| `gitCommitCreated()` | `HEAD` moved forward during the step. |

`fileProduced('hello.txt')` is the simplest guard — assert the artifact exists before the next step reads it.

## Combine several

`validate:` also takes an array. All must pass; the first failure halts the run:

```ts
const WORK = step.define('work', {
  agent: claude(),
  validate: [fileProduced('src/**/*.ts'), gitCommitCreated()],
})
```

## Inline checks

For a one-off assertion, `check(fn)` wraps a function. It receives a `ValidatorCtx` — the step name, cwd, the parsed `returns` value (`ctx.value`), and an `exec` helper — and returns `true`/`ok()` for pass or a string/`fail(reason)` for failure:

```ts
import { check } from 'orch'

const PLAN = step.define('plan', {
  agent: claude(),
  validate: check((ctx) => (ctx.value ? true : 'expected a return value')),
})
```

## Reusable named validators

When you reuse a check across steps, name it with `defineValidator`. The name shows up in failure output, so a red run tells you *which* assertion failed:

```ts
import { defineValidator, ok, fail } from 'orch'

const testsPass = defineValidator('tests-pass', async (ctx) => {
  const { exitCode } = await ctx.exec('bun test')
  return exitCode === 0 ? ok() : fail('test suite failed')
})

const WORK = step.define('work', {
  agent: claude(),
  validate: [gitDiffCreated(), testsPass()],
})
```

`ctx.exec` runs a command in the step's cwd and gives you its exit code — the standard way to gate on a build, a test run, or a linter. Note `testsPass` is a validator *factory*: call it (`testsPass()`) in the `validate:` array.

## How failure behaves

A failed validator throws and halts the workflow, exactly like a runner error. The step is *not* memoized, so a later `orch resume` re-runs it. That's the point — fix the prompt or the environment, resume, and the step gets another chance to satisfy the validator. See [Debugging](/guide/6-debugging) for reading the failure in the logs.

## Where to go next

- [Typed returns](/guides/typed-returns) — validate the *shape* of returned data with a schema instead.
- [Debugging](/guide/6-debugging) — find why a validator failed.
- [Validators reference](/reference/api#validators) — every signature and the `ValidatorCtx` fields.
