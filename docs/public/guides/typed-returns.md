# Typed returns

> **What you'll learn:** how to get structured, type-checked data back from an agent step with `returns:`, and how to consume it.

Most steps produce files. Sometimes you need the agent to hand a *value* back to the workflow — a slug, a count, a list of phases — so you can loop or branch on it. That's what `returns:` is for.

## Declare what a step returns

Add `returns:` to a step, passing a [Zod](https://zod.dev) schema. orch re-exports Zod as `z`, so you don't add it to your own dependencies:

```ts
// .orch/workflows/plan-runner.ts
import { workflow, step, claude, z } from 'orch'

const COUNT_PHASES = step.define('count-phases', {
  agent: claude(),
  prompt:
    'Read every file under ./docs/plan/ and count the distinct implementation phases. ' +
    'Return a single integer in `phases`. If the plan is not phased, return 1.',
  returns: z.object({ phases: z.number().int().min(1).max(30) }),
})

export default workflow('plan-runner', async (run) => {
  const { phases } = await run(COUNT_PHASES) // phases: number
})
```

This bare form is what `orch init` scaffolds. `returns:` also accepts a `schema(...)`-wrapped schema — see [Reusing a wrapped schema](#reusing-a-wrapped-schema) below.

## What orch does with the schema

When a step declares `returns:`, orch:

1. Converts the Zod schema to JSON Schema and passes it to the agent — `--json-schema` for [Claude](/reference/runners#claude), `--output-schema` for [Codex](/reference/runners#codex).
2. Parses the agent's final structured reply.
3. Validates it against the same Zod schema. A mismatch fails the step (a `SchemaValidationError`, same crash/resume semantics as any step failure).
4. Returns the parsed value, fully typed from the schema.

So `phases` above is a real `number` at compile time and a validated integer at runtime — the agent cannot hand you a string or an out-of-range value without failing the step.

## Consuming the value

Because the return is plain typed data, you use it with ordinary TypeScript. Loop over it:

```ts
const { phases } = await run(COUNT_PHASES)
for (let i = 1; i <= phases; i++) {
  await run(EXECUTE_PHASE, { as: `phase-${i}`, extraPrompt: `Implement only phase ${i}.` })
}
```

Branch on a richer shape:

```ts
const PLAN = step.define('plan', {
  agent: claude(),
  returns: z.object({
    phases: z.array(z.object({ name: z.string(), riskLevel: z.enum(['low', 'high']) })),
  }),
})

const plan = await run(PLAN)
for (const phase of plan.phases) {
  if (phase.riskLevel === 'high') {
    await run(REVIEW, { as: `review-${phase.name}`, prompt: `Carefully review ${phase.name}` })
  }
  await run(IMPLEMENT, { as: `impl-${phase.name}`, prompt: `Implement ${phase.name}` })
}
```

`plan.phases[number].riskLevel` is narrowed to `'low' | 'high'` — the schema drives the types end to end.

## Reusing a wrapped schema

A bare Zod schema is the shortest form and is what `orch init` scaffolds.
When you want to reuse one schema across several steps, wrap it once with `schema()` and reference the wrapper by name:

```ts
import { workflow, step, claude, schema, z } from 'orch'

const DECISION = schema(z.object({ type: z.enum(['simple', 'complex']) }))

const DECIDE = step.define('decide', {
  agent: claude(),
  prompt: 'Classify the request as "simple" or "complex". Reply JSON.',
  returns: DECISION,
})
```

Both forms behave identically: orch converts the schema to JSON Schema, validates the reply, and types the result.
See the [`schema` reference](/reference/api#schema) for the exact signature.

## Autonomous only

Structured output requires the agent to run autonomously, so `returns:` is rejected on interactive steps. Combining `mode: 'interactive'` with `returns:` throws at definition time. If you need both a watchable session and a value back, split them: an interactive step to drive, then a small autonomous step to extract the structured result (the [`compound` example](/examples) does exactly this with its `count-phases` step).

## Where to go next

- [Validators](/guides/validators) — assert side effects (files, commits) the schema can't capture.
- [Writing a workflow](/guide/4-writing-a-workflow) — looping and branching on returned data.
- [`schema` reference](/reference/api#schema) — the exact signature.
