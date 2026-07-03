> Internal design draft - the triggers feature is not shipped. Do not publish.

# Triggers and background runs

> **What you'll learn:** how to write a *trigger* — a long-running, reactive workflow that watches for something to happen and launches other workflows in the background — and how to observe and control every run on your machine.

::: warning Design draft — not shipped yet
Triggers don't exist in orch yet. This page is the **spec we're refining** before building. The API names and signatures below are proposals, not released features. When the feature lands, this becomes a real reference page and joins the numbered guide.
:::

A normal workflow runs once and finishes. A **trigger** never finishes on its own: it wakes up on a schedule or an event, decides what work is needed, and **launches other workflows** to do it — then goes back to sleep. You start it once and walk away.

The motivating example: every five minutes, check for failed merge requests; for each one, launch a workflow that tries to fix it — without launching a second fixer for an MR that's already being worked on.

## The mental model: you write the handler, orch owns the loop

The tempting design is "a trigger is just a workflow with a `while (true)` loop in it." orch deliberately does **not** work that way. An infinite loop inside a workflow breaks the things that make workflows reliable — resumability, the run-finished signal, and bounded on-disk state.

Instead: **you write a handler that runs once per tick, and the runtime owns the loop.** Each tick is an ordinary, finite run — it starts, does its work, and ends, exactly like any other workflow. The "forever" part lives outside your code.

This has a practical payoff. Because each tick is a fresh finite run, the best way to write a handler is to make it **level-triggered**: don't try to remember what you saw last time — look at the world as it is *right now* and launch whatever is missing. If your Mac reboots and the trigger restarts, a level-triggered handler just picks up correctly with no lost state.

## `defineTrigger`

A trigger lives in its own file in your project, alongside your workflows. It is built from three parts: **when** it fires (`on`), **how** it avoids duplicate work (`dedup`), and **what** it does each time (`run`).

```ts
import { defineTrigger, cron, claude, command, schema, step, z } from 'orch'
import fixMr from '../workflows/fix-mr/index.ts'

const FAILED_MRS = command('list-failed-mrs', {
  argv: ['glab', 'mr', 'list', '--json', '--status=failed'],
  onFailure: 'continue',
})

const PARSE = step.define('parse-failed', {
  agent: claude({ model: 'claude-haiku-4-5-20251001' }),
  prompt: 'From this glab JSON, return the failed MR iids:\n{{json}}',
  returns: schema(z.object({ iids: z.array(z.number()) })),
})

export default defineTrigger({
  name: 'mr-checker',
  on: cron('5m'),
  dedup: 'subject',
  run: async (run, ctx) => {
    const listed = await run(FAILED_MRS)
    const { iids } = await run(PARSE, { vars: { json: listed.stdout } })

    for (const iid of iids) {
      ctx.launch(fixMr, { prompt: `Fix the CI failure on MR !${iid}` }, {
        subject: `mr-${iid}`,
      })
    }
  },
})
```

Inside `run`, you use the same `run()`, `step.define()`, and `command()` you already know from writing workflows. The only new thing is `ctx.launch()`.

## Trigger sources: `on`

The `on` field is the single place that decides *when* the handler fires. The same handler shape works for a schedule or an event — you only change `on`.

| Source | Fires when | `ctx.event` |
| --- | --- | --- |
| `cron('5m')` / `cron('0 * * * *')` | On a schedule (interval shorthand or cron expression). | `void` |
| `webhook('/ci')` | An HTTP request hits the local endpoint. | the request payload |
| `manual()` | You run `orch fire <trigger>` by hand. | `void` |
| event adapters (e.g. `slack.mention('#ci')`) | A pluggable external event arrives. | the event |

```ts
// Same handler shape — fires on an incoming webhook instead of a timer.
export default defineTrigger({
  name: 'ci-webhook',
  on: webhook('/ci-failed'),
  dedup: (evt) => `mr-${evt.mrIid}`,
  run: async (run, ctx) => {
    ctx.launch(fixMr, { prompt: `Fix MR !${ctx.event.mrIid}` })
  },
})
```

::: info v1 scope
`cron`, `webhook`, and `manual` are the built-in sources. Event adapters like Slack or GitLab are examples you can write against the same interface — they are not core guarantees in the first version.
:::

## Launching work: `ctx.launch`

`ctx.launch()` starts another workflow as its **own independent background run** — a separate run id, its own state, its own process. It is not a sub-workflow: the trigger does not wait for it and is not its parent. Fire and forget.

```ts
ctx.launch(fixMr, { prompt: `Fix MR !${iid}` }, { subject: `mr-${iid}` })
```

The `subject` is the key to **deduplication**. Before launching, orch checks whether a run is already in flight for that subject. If one is, the launch is **skipped** — you never get two fixers fighting over `mr-123`. The skip is not silent; it comes back as a result you can see and act on:

```ts
const result = ctx.launch(fixMr, { prompt: `Fix MR !${iid}` }, { subject: `mr-${iid}` })

// result is one of:
//   { status: 'launched', runId: 'r-2026-...' }
//   { status: 'skipped', reason: 'in-flight', subject: 'mr-123' }
```

::: tip Subjects are yours to define
A subject is just a string you choose to mean "this unit of work." `mr-123`, `deploy-prod`, `flaky-test-login` — orch never infers it. Pick a stable key per thing-that-should-only-be-worked-on-once.
:::

Under the hood, dedup is enforced by an atomic, per-subject lease on disk. If the run holding a lease crashes, the lease is reclaimed automatically the next time someone checks — a dead holder never blocks future work forever.

## Running a trigger

A trigger is started like any workflow, with one new flag.

```bash
orch run mr-checker                 # foreground — watch it work
orch run mr-checker --background    # detached — start it and walk away
```

**Foreground** (no flag): the trigger runs in the normal two-pane view. You watch each tick fire and each child launch happen live, exactly like watching any run. Good for developing and debugging a trigger.

**Background** (`--background`): the trigger detaches from your terminal and keeps running after you close it (or log out and back in). This is the "turn on my Mac, start it once, forget about it" mode.

The flag only changes **who owns the process** — not what's observable. A backgrounded trigger records everything just the same; you simply attach to it later instead of watching it now.

## Mission control: seeing and steering every run

Once work is running in the background — triggers and the workflows they launch — you need a way to see it all. That's `orch ps`.

```bash
orch ps                       # every live run on this machine
orch ps --project             # just this project
orch ps --project --worktrees # this project and its worktrees
```

`orch ps` is machine-wide by default: it shows every live run regardless of which project started it, because a trigger in one project can launch work that you'll want to find from anywhere. The `--project` and `--worktrees` filters narrow the view when you only care about where you are.

To pull any background run into your terminal and watch it live — or take over an interactive step — **attach** to it:

```bash
orch attach <runId>
```

Attaching brings a background run to the foreground; detaching (the usual tmux detach) sends it back to running quietly. You can move any run between background and foreground at will.

## History: what fired, and what it launched

A trigger is itself a run, so it has the same history any run does — every tick it executed is on the record. And because each launched workflow registers the **subject** and the **trigger that launched it**, you get a full audit trail:

- which ticks fired, and when;
- for each tick, what it launched — `launched run r-… for mr-123`, or `skipped mr-124 (already in flight)`;
- the set of subjects currently in flight.

```bash
orch ps                  # live: what's running now, including in-flight subjects
orch history mr-checker  # past: every tick and what each one launched or skipped
```

So "did my trigger actually do anything at 3am?" is a question you can answer after the fact, not just by watching live.

## How this stays local (for now)

Everything here is **machine-local**. The registry of runs and the dedup leases live in a machine-level home directory, separate from any single project's `.orch/`, which is what lets `orch ps` see across projects. There is no shared server and no syncing to teammates' machines yet — the design leaves room for that later, but the first version is just you and your Mac.

## Where to go next

- [Core concepts](/guide/3-core-concepts) — steps, `run()`, and memoization, which triggers build on.
- [Writing a workflow](/guide/4-writing-a-workflow) — the workflows a trigger launches.
- [Running workflows](/guide/5-running-workflows) — run modes and the two-pane view you attach to.
