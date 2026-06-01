# Writing a workflow

> **What you'll learn:** how to compose several steps in one file, pass a step's result into the next step, loop, and branch — using only plain TypeScript.

[Getting started](/guide/2-getting-started) ran a single step. Real workflows chain several. Because a workflow is an ordinary async function, you compose steps with the same tools you already know: `await`, `for`, `if`, and local variables.

## Defining several steps

Declare each step once as a top-level constant, then invoke them in order inside the workflow body:

```ts
// .orch/workflows/feature.ts
import { workflow, step, claude } from 'orch'

const BRAINSTORM = step.define('brainstorm', {
  agent: claude(),
  prompt: 'Brainstorm the feature in the prompt. Write ./feature/brainstorm.md.',
})

const PLAN = step.define('plan', {
  agent: claude(),
  prompt: 'Read ./feature/brainstorm.md and write a phased plan to ./feature/plan.md.',
})

export default workflow('feature', async (run) => {
  await run(BRAINSTORM)
  await run(PLAN)
})
```

`PLAN` runs only after `BRAINSTORM` resolves. The two steps share work through a file on disk — the most common way agents hand off to each other.

## Reading the inline prompt

The workflow function receives a second argument, `args`, carrying the prompt from the command line (`orch run feature "add a CSV exporter"`). Use it to drive the run:

```ts
export default workflow('feature', async (run, args) => {
  if (args.prompt === undefined || args.prompt.trim() === '') {
    throw new Error('feature requires a prompt. Usage: orch run feature "describe the feature"')
  }
  const request = `Feature request:\n${args.prompt}`

  await run(BRAINSTORM, { extraPrompt: request })
  await run(PLAN)
})
```

`extraPrompt` appends text to the step's default prompt for this one call (see the [overrides table](/guide/3-core-concepts#the-run-primitive)). The brainstorm step now sees both its standing instruction and the user's request.

## Moving long prompts into `.md` files

A two-paragraph backticked string buries the pipeline shape. orch lets each step point at a sibling Markdown file with `promptFile:`. The file's `{{var}}` placeholders are filled in at `run()` time so the same step can be reused with different inputs:

```ts
const BRAINSTORM = step.define('brainstorm', {
  agent: claude(),
  promptFile: 'brainstorm.md',           // sibling file next to this workflow .ts
})

await run(BRAINSTORM, { vars: { request: args.prompt } })   // {{request}} substituted here
```

Substitution is strict in both directions — a missing key or an unused key throws before the runner starts, so typos surface immediately. For prose shared by more than one workflow, drop it under `.orch/prompts/` at your project root and reference it with the `@/` sentinel (`promptFile: '@/.orch/prompts/session-context.md'`).

For compile-time safety on the `vars` contract — TypeScript catching missing/extra/wrong vars at every `run()` site — see [Typed prompt vars](/guides/typed-prompt-vars). The [File-based prompts](/guides/file-based-prompts) guide covers the rest of the surface, including the `loadPrompt()` helper for composing fragments.

## Passing a typed result into the next step

A step can return structured data instead of only writing files. Declare what it returns with `returns: schema(...)`, where `schema` wraps a [Zod](https://zod.dev) schema. orch re-exports Zod as `z`, so you don't add it to your own dependencies:

```ts
import { workflow, step, claude, schema, z } from 'orch'

const COUNT_PHASES = step.define('count-phases', {
  agent: claude(),
  prompt: 'Read ./feature/plan.md and return the number of phases as `phases`.',
  returns: schema(z.object({ phases: z.number().int().min(1).max(30) })),
})

export default workflow('feature', async (run) => {
  await run(PLAN)
  const { phases } = await run(COUNT_PHASES) // phases: number, type-checked
})
```

orch hands the schema to the agent, validates the reply against it, and types the return value. The [Typed returns](/guides/typed-returns) guide covers this in depth.

## Looping over a result

Because `phases` is a plain number, you loop with a plain `for`. The one rule from [Core concepts](/guide/3-core-concepts#the-run-primitive): each call of the *same* step needs a distinct `as:` name, or the calls collide on one memoization key.

```ts
const EXECUTE_PHASE = step.define('execute-phase', {
  agent: claude(),
  prompt: 'Read ./feature/plan.md and implement the requested phase.',
})

export default workflow('feature', async (run) => {
  await run(PLAN)
  const { phases } = await run(COUNT_PHASES)

  for (let i = 1; i <= phases; i++) {
    await run(EXECUTE_PHASE, {
      as: `phase-${i}`,
      extraPrompt: `Implement only phase ${i}. Leave later phases for a future run.`,
    })
  }
})
```

Each iteration memoizes under `phase-1`, `phase-2`, … so a crash after phase 2 resumes at phase 3 — the finished phases return from cache. This is the pattern the [`compound` example](/examples) uses to run a plan phase by phase.

## Branching

Branch on a return value with an ordinary `if`. There is no special construct — the function is just TypeScript:

```ts
const { phases } = await run(COUNT_PHASES)

if (phases > 10) {
  await run(SPLIT_PLAN) // a step that breaks a large plan into milestones first
}
```

The same applies to early returns, `try/catch`, and `while`. Remember the idempotency rule: code *between* `run()` calls re-executes on every resume, so keep it free of one-way side effects (see [Memoization and resume](/guide/3-core-concepts#memoization-and-resume)).

## A complete multi-step workflow

Putting it together — brainstorm, plan, count, then a phase-by-phase loop:

```ts
// .orch/workflows/feature.ts
import { workflow, step, claude, schema, z } from 'orch'

const BRAINSTORM = step.define('brainstorm', {
  agent: claude(),
  prompt: 'Brainstorm the feature in the prompt. Write ./feature/brainstorm.md.',
})

const PLAN = step.define('plan', {
  agent: claude(),
  prompt: 'Read ./feature/brainstorm.md and write a phased plan to ./feature/plan.md.',
})

const COUNT_PHASES = step.define('count-phases', {
  agent: claude(),
  prompt: 'Read ./feature/plan.md and return the number of phases as `phases`.',
  returns: schema(z.object({ phases: z.number().int().min(1).max(30) })),
})

const EXECUTE_PHASE = step.define('execute-phase', {
  agent: claude(),
  prompt: 'Read ./feature/plan.md and implement the requested phase.',
})

export default workflow('feature', async (run, args) => {
  if (args.prompt === undefined || args.prompt.trim() === '') {
    throw new Error('feature requires a prompt. Usage: orch run feature "describe the feature"')
  }

  await run(BRAINSTORM, { extraPrompt: `Feature request:\n${args.prompt}` })
  await run(PLAN)

  const { phases } = await run(COUNT_PHASES)
  for (let i = 1; i <= phases; i++) {
    await run(EXECUTE_PHASE, {
      as: `phase-${i}`,
      extraPrompt: `Implement only phase ${i}.`,
    })
  }
})
```

## Where to go next

- [Running workflows](/guide/5-running-workflows) — run, resume, and inspect what you just wrote.
- [Typed returns](/guides/typed-returns) — get structured data back from a step.
- [Parallel work](/guides/parallel-work) — run independent steps at once instead of in sequence.
