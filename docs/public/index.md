---
layout: home

hero:
  name: orch
  text: Your coding agents, on rails.
  tagline: Chain Claude Code, Codex, and any agent CLI into one typed, resumable TypeScript workflow. Watch every step live in your terminal.
  actions:
    - theme: brand
      text: Get started
      link: /guide/2-getting-started
    - theme: alt
      text: What is orch?
      link: /guide/1-what-is-orch
    - theme: alt
      text: API reference
      link: /reference/api

features:
  - icon: 🧩
    title: It's just TypeScript
    details: No YAML, no graph builder. Branch with if, loop with for, wait with await. orch runs your function top to bottom.
  - icon: 🔁
    title: Crash-proof by default
    details: Every step result is persisted by name. Ctrl-C, CI timeout, closed laptop - orch resume replays the function and only unfinished steps actually run.
  - icon: 🤝
    title: Mix and match agents
    details: claude() and codex() are interchangeable runners. Hand typed, schema-validated data from one step to the next, or fan out in parallel.
  - icon: 👀
    title: Watch it work
    details: Two-pane tmux mode shows live step status on the left and the active agent's transcript on the right. Plain mode streams to stdout for CI.
---

## A whole pipeline in one file

A workflow is a plain async function.
Define each step once, then compose them with the TypeScript you already know:

```ts
// .orch/workflows/goal.ts
import { workflow, step, commit, claude, schema, z } from 'orch'

const PLAN = step.define('plan', {
  agent: claude(),
  prompt: 'Write a phased implementation plan to ./plan.md.',
})

const COUNT = step.define('count-phases', {
  agent: claude(),
  prompt: 'Read ./plan.md and return the number of phases as `phases`.',
  returns: schema(z.object({ phases: z.number().int().min(1) })),
})

const BUILD = step.define('build', {
  agent: claude(),
  prompt: 'Read ./plan.md and implement the requested phase.',
})

export default workflow('goal', async (run, args) => {
  await run(PLAN, { extraPrompt: args.prompt ?? '' })

  const { phases } = await run(COUNT) // typed: phases is a number
  for (let i = 1; i <= phases; i++) {
    await run(BUILD, { as: `phase-${i}`, extraPrompt: `Implement only phase ${i}.` })
  }

  await run(commit('feat: do something great'))
})
```

```bash
orch run goal "let's do something great"
```

If the run dies after phase 1, `orch resume --latest` re-executes the function - finished steps return instantly from cache, and the run picks up at phase 2.

## Start here

1. [What is orch?](/guide/1-what-is-orch) - the mental model in four ideas.
2. [Getting started](/guide/2-getting-started) - install, scaffold, and run your first workflow in five minutes.
3. [Writing a workflow](/guide/4-writing-a-workflow) - chain steps, pass typed data, loop, and branch.
