# Core concepts

> **What you'll learn:** the vocabulary you'll use in every workflow — steps, the `run()` primitive, memoization and resume, step kinds, interactivity, and run modes.

## Steps

A **step** is a reusable named constant created by a factory. The most common is an *agent step* from `step.define`:

```ts
import { step, claude } from 'orch'

const PLAN = step.define('plan', {
  agent: claude({ model: 'claude-opus-4-7' }),
  prompt: 'Draft an implementation plan for the requested feature.',
})
```

The first argument — `'plan'` — is the step **name**, which is also its memoization key. Other step kinds (`commit`, `createWorktree`, `ask`, `command`) come from their own factories and slug their names automatically; see [Step kinds](#step-kinds).

## The `run()` primitive

`run` is the single argument orch passes to your workflow function. It is the only way to invoke a step. It returns the step's typed result:

```ts
export default workflow('feature', async (run) => {
  const plan = await run(PLAN, { prompt: 'Plan the auth refactor' })
})
```

The second argument is a set of per-call **overrides**:

| Override | Effect |
| --- | --- |
| `as` | Memoize this call under a different name. Required when you `run()` the same step twice. |
| `prompt` | Replace the step's default prompt for this call. |
| `extraContext` | A JSON value appended to the prompt (serialized). |
| `extraPrompt` | Extra text appended after the prompt. |
| `mode` | Force `'interactive'` or `'autonomous'` for this call. |

```ts
await run(WORK, { as: 'work-auth', prompt: 'Implement the auth module' })
await run(WORK, { as: 'work-api', prompt: 'Implement the API module' })
```

Without distinct `as:` names, running the same step twice collides on one memoization key.

## Memoization and resume

This is the idea that shapes everything. Every `run()` call checks `state.json` for a cached entry under its name:

- **Hit** → return the cached value, skip execution.
- **Miss** → run the step, persist the result, return it.

So **resume re-executes the whole workflow function**, but every `run()` that already completed returns instantly from cache. The first one that didn't finish actually runs.

```
First run                            orch resume
─────────                            ───────────
run(PLAN)   → executes, cached       run(PLAN)   → cache hit, instant
run(WORK)   → executes, cached       run(WORK)   → cache hit, instant
run(REVIEW) → crash 💥               run(REVIEW) → cache miss, executes
```

The practical consequence: **code between `run()` calls runs every time the function executes** — including on every resume. Keep it idempotent.

```ts
// BAD — appends twice on resume
await run(PLAN)
await fs.appendFile('log.txt', 'planned\n')   // re-runs on every resume
await run(WORK)
```

Make side effects idempotent, or move them inside a step. See [Debugging](/guide/6-debugging) and the [resume CLI command](/reference/cli#resume).

## Step kinds

A workflow is built from five kinds of step. Each has its own factory.

| Kind | Factory | What it does |
| --- | --- | --- |
| agent | `step.define(name, config)` | Run an agent (`claude()`, `codex()`, or your own runner). |
| ask | `ask({ ... })` | Prompt the human for input; returns a typed result. |
| command | `command(name, { argv, onFailure })` | Run a shell command as a first-class, streamed, memoized step. |
| commit | `commit(message)` | Stage everything and create a git commit. |
| worktree | `createWorktree(branch, { enter })` | Create a git worktree and optionally switch the workflow's cwd into it. |

Full signatures and options live in the [Authoring API reference](/reference/api).

## Interactivity: autonomous vs interactive steps

Agent steps run in one of two modes:

- **Autonomous** (default) — orch streams the agent's NDJSON output, renders a transcript, and waits for the agent to finish on its own. No human at the keyboard.
- **Interactive** (`mode: 'interactive'`) — orch spawns the agent's real TUI in a pane; you talk to it directly. Set `autoStop: true` to have orch close the pane automatically when the agent finishes its turn, so an unattended pipeline doesn't stall. `autoStop` requires a runner that supports it and is only valid on interactive steps.

Separately, the **run-level interactivity axis** controls [`ask()`](/reference/api#ask) steps:

- `--interactive` (default) renders prompts normally.
- `--noninteractive` (or `ORCH_NONINTERACTIVE=1`) resolves each `ask()` from its declared `defaultWhenNoninteractive` — for CI and scheduled runs. An `ask()` with no default errors in this mode.

## Run modes

A run mode decides *where the views render*. orch ships two wired modes (`single-pane` is reserved for a future version):

| Mode | When it's chosen | What you see |
| --- | --- | --- |
| `plain` | CI, no TTY, or `--mode=plain` | Transcript lines on stdout. `--format=json` emits one NDJSON envelope per event. |
| `two-pane` | TTY + tmux ≥ 3.2, or `--mode=two-pane` | A tmux session: left pane = live status of every step, right pane = the active step's transcript or interactive TUI. |

Resolution precedence: `--mode` flag > `defaultMode` in `orch.config.ts` > CI → plain > TTY + tmux → two-pane > fallback plain. See the [CLI reference](/reference/cli#run-modes) for the full table and flags like `--no-attach`.

## Where to go next

- [Writing a workflow](/guide/4-writing-a-workflow) — put these pieces together.
- [Authoring API reference](/reference/api) — exact signatures for every factory and override.
