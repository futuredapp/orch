---
layout: home

hero:
  name: orch
  text: Chain coding agents into resumable workflows
  tagline: Write a plain TypeScript function. orch spawns Claude Code and Codex, passes typed data between steps, watches them in tmux, and resumes from exactly where you crashed.
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
  - title: Workflows are TypeScript
    details: No YAML, no graph builder, no visual editor. Use if, for, while, await, and early returns. orch runs the function top to bottom.
  - title: Resumable by default
    details: Every run() call is memoized by name. Crash, Ctrl-C, or CI timeout — orch resume re-runs only the steps that did not finish.
  - title: Multiple agents, one pipeline
    details: claude() and codex() are first-class runners. Hand structured, typed data from one step to the next; run independent work in parallel.
  - title: Watch it work
    details: Two-pane tmux mode shows a live status pane and the agent's transcript. Plain mode streams to stdout for CI and logs.
---

## In one file

```ts
import { workflow, step, commit, claude } from 'orch'

const WORK = step.define('work', {
  agent: claude(),
  validate: gitDiffCreated(),
})

export default workflow('hello', async (run) => {
  await run(WORK, { prompt: 'Add a CHANGELOG.md with an Unreleased section' })
  await commit('docs: add changelog')
})
```

```bash
orch run hello
```

New here? Start with [What is orch?](/guide/1-what-is-orch), then [Getting started](/guide/2-getting-started).
