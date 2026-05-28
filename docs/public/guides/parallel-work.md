# Parallel work

> **What you'll learn:** how to run genuinely independent steps at the same time with `parallel()`, in both its forms, without losing resumability.

By default `await run(...)` is sequential — each step waits for the one before it. When steps don't depend on each other, `parallel()` runs them concurrently and collects the results. It comes in two forms.

## Heterogeneous: different steps at once

Pass an array of `run()` calls. `parallel()` returns a tuple of their results, in order:

```ts
import { workflow, step, claude, codex, parallel } from 'orch'

const RESEARCH_CLAUDE = step.define('research-claude', { agent: claude() })
const RESEARCH_CODEX = step.define('research-codex', { agent: codex() })

export default workflow('research', async (run) => {
  const [approachA, approachB] = await parallel([
    run(RESEARCH_CLAUDE, { as: 'approach-a', prompt: 'Research approach A' }),
    run(RESEARCH_CODEX, { as: 'approach-b', prompt: 'Research approach B' }),
  ])
  // approachA and approachB are typed by their respective steps
})
```

Use this when each branch is a distinct piece of work — two agents researching different angles, say.

## Homogeneous: the same step over many inputs

Pass a list of items and a function. Every item runs the same step with a different input. An optional `concurrency` cap limits how many run at once:

```ts
import { workflow, step, claude, parallel } from 'orch'

const REVIEW = step.define('review', { agent: claude() })

export default workflow('multi-lens-review', async (run) => {
  const reviews = await parallel(
    ['security', 'performance', 'design'],
    (lens) => run(REVIEW, { as: `review-${lens}`, prompt: `Review the diff for ${lens}` }),
    { concurrency: 2 },
  )
  // reviews: one result per lens, in input order
})
```

This is the fan-out pattern — N copies of one step, here capped at two in flight. Without `concurrency`, all items start at once.

## Every branch needs a stable `as:`

Both forms reuse one step definition across several calls, so each branch needs a distinct `as:` name — exactly the rule from [Core concepts](/guide/3-core-concepts#the-run-primitive). That naming is also what makes a parallel block resumable: each branch memoizes under its own key, so if the run crashes after two of three reviews finished, resume re-runs only the third. Derive the name from the input (`review-${lens}`) and it stays stable across resumes.

## Don't parallelize ordered work

`parallel()` is only for work that is genuinely independent. Sequential, dependent steps — brainstorm → plan → implement — belong in a plain `for` loop or successive `await`s. Running dependent work concurrently produces races, not speedups.

::: warning Interactive steps can't run in parallel
A `parallel()` branch cannot be an interactive step — there's only one right pane to drive. Keep interactive steps in the sequential body. (Worktree steps with `enter: true` are valid only in the homogeneous form; see [Worktrees and commits](/guides/worktrees-and-commits).)
:::

## Where to go next

- [Worktrees and commits](/guides/worktrees-and-commits) — give each parallel branch its own checkout.
- [Writing a workflow](/guide/4-writing-a-workflow) — the sequential composition this builds on.
- [`parallel` reference](/reference/api#parallel) — both signatures in full.
