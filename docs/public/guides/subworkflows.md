# Subworkflows

> **What you'll learn:** when to extract a step sequence into its own workflow file, how to invoke it from a parent via `runWorkflow(...)`, and the rules that keep extraction safe (cache keys, single-invocation, depth bound, cwd isolation).

Most workflows start as one file. As the body grows, three things can pull a contiguous sub-sequence of steps into its own file:

- **Reuse.** The same sequence runs from more than one parent — e.g. a `plan → implement → verify` chain you want to call from both a feature workflow and a bugfix workflow.
- **Length.** The workflow body is large enough that grouping it into a named sub makes the parent readable.
- **Standalone runnability.** You want the sub-sequence to be runnable on its own via `orch run <name>` (e.g. `orch run simple-feature "..."`) in addition to being composed inside another workflow.

When at least one of those applies, lift the sequence into its own file with `workflow(...)` and call it from the parent with `runWorkflow(...)`.

## The dual-role file pattern

A subworkflow file looks identical to any other workflow file — `export default workflow(...)`. The export is loadable both ways:

```ts
// examples/simple-feature/index.ts
import { step, workflow, type WorkflowArgs } from 'orch'
import { claude } from 'orch'

export interface SimpleFeatureArgs extends WorkflowArgs {
  readonly prompt: string
}

const PLAN = step.define('plan', {
  agent: claude({ bare: false }),
  prompt: 'Outline a small plan for: {{prompt}}',
})

const IMPLEMENT = step.define('implement', {
  agent: claude({ bare: false }),
  prompt: 'Implement the plan from the previous step.',
})

export default workflow<SimpleFeatureArgs>('simple-feature', async (run, args) => {
  await run(PLAN, { vars: { prompt: args.prompt } })
  await run(IMPLEMENT)
})
```

The same file is callable from:

- The CLI: `bunx orch run simple-feature "add a sandbox renderer"` — `args.prompt` is the inline prompt.
- A parent workflow:

  ```ts
  // examples/feature/index.ts
  import { runWorkflow, workflow } from 'orch'
  import simpleFeature from '../simple-feature/index.ts'

  export default workflow('feature', async (_run, args) => {
    await runWorkflow(simpleFeature, { prompt: args.prompt ?? '' })
  })
  ```

## Typed `Args`

`workflow<Args>(...)` is generic. `Args` must extend `WorkflowArgs` (the built-in `{ prompt?: string }`), so a sub that takes additional fields can declare them in one place:

```ts
interface ReviewArgs extends WorkflowArgs {
  readonly prompt: string
  readonly lens: 'security' | 'performance' | 'design'
}

export default workflow<ReviewArgs>('review', async (run, args) => {
  await run(REVIEW, { vars: { lens: args.lens, prompt: args.prompt } })
})
```

The parent then passes a value of `ReviewArgs` to `runWorkflow(review, { prompt, lens: 'security' })`. The CLI top-level only supplies `args.prompt`, so subs that require non-prompt fields are sub-only — call them from a parent that builds the full `args`.

## What `runWorkflow` does

```ts
async function runWorkflow<Args extends WorkflowArgs>(
  executor: WorkflowExecutor<Args>,
  args: Args,
): Promise<void>
```

`runWorkflow(sub, args)` is inline-equivalent execution of the sub's body, with two deliberate divergences:

1. **A fresh sub-frame.** A sub-`AsyncLocalStorage` frame is pushed so the sub's `setWorkflowCwd(...)` and `createWorktree({ enter: true })` cannot leak back to the parent (see [Cwd isolation](#cwd-isolation) below).
2. **`subworkflow:enter` / `subworkflow:exit` lifecycle events.** Hosts that render boundaries (the two-pane view) draw a `▼ <name>` row when the sub enters and a `✓ <name>` / `✗ <name>` row when it exits. The plain host prints a divider line in the same positions.

Everything else — `runId`, state store, log directory, captureLock — is shared with the parent. The sub's steps land in the same `state.json` as the parent's.

## Cache keys: every sub-step is namespaced

Sub-internal step names are persisted under a namespaced cache key. If `simple-feature` declares a `plan` step, it persists under the key `simple-feature>plan`. A different sub `complex-feature` declaring its own `plan` step persists under `complex-feature>plan`. The two are distinct cache entries.

The practical effect: two subs with overlapping step names can run from the same parent without colliding, and the parent's own `plan` step (if any) at the root is `plan` — separate from both.

This rule is what makes the `feature` example below safe — both `simple-feature` and `complex-feature` declare a `plan` step, but each lives under its own sub-prefixed key.

```ts
// examples/feature/index.ts
import { runWorkflow, schema, step, workflow } from 'orch'
import { z, claude } from 'orch'
import simpleFeature from '../simple-feature/index.ts'
import complexFeature from '../complex-feature/index.ts'

const DECISION = schema(z.object({ type: z.enum(['simple', 'complex']) }))

const DECIDE = step.define('decide', {
  agent: claude({ bare: false }),
  prompt: `Classify the request as "simple" or "complex". Reply JSON. Request: {{prompt}}`,
  returns: DECISION,
})

export default workflow('feature', async (run, args) => {
  const decision = await run(DECIDE, { vars: { prompt: args.prompt ?? '' } })
  if (decision.type === 'simple') {
    await runWorkflow(simpleFeature, { prompt: args.prompt ?? '' })
  } else {
    await runWorkflow(complexFeature, { prompt: args.prompt ?? '' })
  }
})
```

## Single-invocation limit (v1)

In v1 a given sub workflow may be invoked at most **once per parent run**. Calling `runWorkflow(simpleFeature, args)` twice in the same run throws `StepNameCollisionError` on the second invocation, naming the colliding step key.

The motivation: without a per-invocation prefix to disambiguate cache keys, two invocations would write the same `simple-feature>plan` key and silently overwrite each other on resume. A future `{ stepPrefix }` option will lift this restriction; until then, the canonical pattern for "the same sequence N times" is N **distinct** subs in a parallel block:

```ts
// examples/ship-many/index.ts
import { parallel, runWorkflow, workflow } from 'orch'

const shipA = workflow('ship-a', async (run, args) => { /* ... */ })
const shipB = workflow('ship-b', async (run, args) => { /* ... */ })

export default workflow('ship-many', async (_run, args) => {
  await parallel(
    [{ name: 'ship-a', sub: shipA }, { name: 'ship-b', sub: shipB }],
    async (branch) => {
      await runWorkflow(branch.sub, { prompt: args.prompt ?? '' })
    },
  )
})
```

`ship-a` and `ship-b` can have overlapping step names — their keys live under different sub prefixes (`ship-a>plan` vs `ship-b>plan`).

## Cwd isolation

Inside a sub, `setWorkflowCwd(...)` and `createWorktree({ enter: true })` mutate the sub-frame's cwd slot — they do **not** leak back to the parent. After `runWorkflow(sub, args)` returns, the parent's subsequent `run(...)` calls see the parent's original cwd.

```ts
// examples/parent/index.ts — the parent's cwd is unchanged after the sub returns
import { runWorkflow, step, workflow } from 'orch'
import branchIsolated from '../branch-isolated/index.ts'

export default workflow('parent', async (run, args) => {
  await run(HELLO)                          // runs at parent cwd
  await runWorkflow(branchIsolated, args)   // sub does createWorktree({enter:true})
  await run(REPORT)                         // back at parent cwd
})
```

This isolation is per-sub — nested subs each get their own frame, so an inner sub's cwd change is bounded to the inner sub and does not leak to the outer sub.

## Depth bound

`runWorkflow` chains are bounded — the default is **8** levels deep. Beyond that, `runWorkflow` throws `SubworkflowDepthError` before invoking the sub. The bound exists to catch accidental recursion (a sub that calls itself transitively) and runaway composition trees.

When you genuinely need a deeper chain, override the bound per execution via `WorkflowDeps.maxSubworkflowDepth`:

```ts
const deps: WorkflowDeps = {
  // ...
  maxSubworkflowDepth: 16,
}
await myWorkflow.execute(deps)
```

The override is read once at workflow-root construction and propagated to every sub-frame, so concurrent in-process executions can carry different bounds.

## Subworkflows inside `parallel()`

A `runWorkflow(...)` call inside a `parallel()` branch is legal. Every step inside such a sub is marked `insideParallel: true` on its persisted entry, and the two-pane view suppresses the sub's `▼`/`✓` boundary rows uniformly across the subtree — the parallel rollup is the visual frame, not the sub gutter. The lifecycle.ndjson still records every `subworkflow:enter`/`subworkflow:exit` event so the trace stays complete.

## Where to go next

- [`runWorkflow` reference](/reference/api#runworkflow) — full signature.
- [Parallel work](/guides/parallel-work) — the parallel-of-subs canonical shape.
- [Worktrees and commits](/guides/worktrees-and-commits) — the cwd-isolation primitive that makes nested subs safe.
