# What is orch?

> **What you'll learn:** what orch does, the problem it solves, and the four ideas that make everything else fall into place.

`orch` is a small tool for chaining coding-agent CLIs (Claude Code, Codex, and anything else you wrap) into deterministic, resumable workflows.
You write the workflow as a plain TypeScript async function.
orch handles the parts that are boring but important:

- spawning the agents and streaming their output,
- passing typed data between steps,
- letting you watch each agent live in tmux,
- pausing for your input when a decision is needed,
- validating that each step produced what it promised,
- resuming from exactly where a run crashed.

The problem it solves: a "compound engineering" loop (brainstorm → plan → work → review → ship) is already a deterministic chain.
You, the human, say *"yes, do the next one"* at every transition.
orch automates the transitions and keeps you in the loop only at the moments that actually need a decision.

## What it is not

- **Not a hive-mind.** No consensus protocols, no agents deciding which agent goes next. The workflow is a static skeleton you wrote.
- **Not a YAML DSL.** Workflows are TypeScript. Branching is `if`; repetition is `for`/`while`.
- **Not a web UI.** Observability lives in your terminal — you watch each agent work in real time.
- **Not a replacement for Claude Code or Codex.** It *drives* them; they still do the actual coding.

## The mental model

Four ideas. If you understand these, the rest is syntax.

**1. A workflow is a plain async function.** You write ordinary TypeScript. orch runs the function top to bottom and passes you one argument: the `run` primitive.

**2. A step is a reusable named constant.** You define a step once — which agent runs it, its default prompt, what it should produce, what it should return. You can invoke the same step many times with different overrides at the call site.

**3. `run(STEP)` is the only magic word.** Every `run()` call is spawned, observed, validated, and its result is **persisted by name**. Code *between* `run()` calls executes every time the function runs (so keep it idempotent). Code *inside* a `run()` call executes once per name, then is cached.

**4. Resume = re-execute the function, but `run()` returns cached values for names that already finished.** This is the same model Inngest and Restate use. It is the single most important thing to internalize, because it shapes how you structure workflows.

Everything else — `parallel()`, `commit()`, `ask()`, custom runners, dry-run — is built on those four ideas.

## A first look

```ts
import { workflow, step, commit, claude } from 'orch'
import { gitDiffCreated } from 'orch'

const WORK = step.define('work', {
  agent: claude(),
  validate: gitDiffCreated(),
})

export default workflow('feature', async (run) => {
  // `run()` spawns Claude, waits for it, checks the validator, persists the result.
  await run(WORK, { prompt: 'Add a CHANGELOG.md with an Unreleased section' })

  // A first-class commit step — shows up in status and state.json.
  await run(commit('docs: add changelog'))
})
```

If this run is interrupted after `WORK` finishes, `orch resume` replays the function: `WORK` returns its cached result instantly, and execution continues at `commit`.

## Where to go next

- [Getting started](/guide/2-getting-started) — install, scaffold, and run your first workflow.
- [Core concepts](/guide/3-core-concepts) — steps, runs, modes, and resume in depth.
