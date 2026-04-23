---
date: 2026-04-09
status: draft — decision review
audience: someone who has never heard of this project
goal: after reading this once, you know ~80% of how to use the orchestrator
---

# Getting Started with `orch` — the Claude + Codex Orchestrator

> **Heads up — this document is a decision review, not a user manual for shipped software.** Nothing in here is built yet. The point is to describe what we *want* to build in enough detail that a reader can say "yes, I understand what this is and how I'd use it" or "wait, this part doesn't make sense." If something feels off, that's the feedback we're looking for.
>
> The project name (`orch`) is a placeholder. See the open questions at the bottom.

---

## 1. What is this?

`orch` is a small tool for chaining coding-agent CLIs (Claude Code, Codex, and anything else you care to wrap) into deterministic, resumable workflows. You write the workflow as a plain TypeScript async function. The orchestrator handles the boring but important parts: spawning the agents, passing typed data between steps, observing them in tmux, asking the human for input when something needs a decision, validating that each step produced what it promised, and resuming from exactly where you crashed.

The problem it solves: a "compound engineering" loop — brainstorm → plan → work → review → ship — is already a deterministic chain. You, the human, are saying *"yes, do the next one"* at every transition. The orchestrator automates the transitions and keeps you in the loop only at the moments that actually need a decision.

**What it is NOT:**
- A hive-mind. No consensus protocols, no "agents deciding which agent goes next."
- A YAML DSL. Workflows are TypeScript.
- A web UI. Observability lives in tmux; you see exactly what each agent is doing, in real time.
- A replacement for Claude Code or Codex. It *drives* them — they still do all the actual coding.

---

## 2. The mental model (read this twice)

Four ideas. If you understand these, the rest is syntax.

**1. A workflow is a plain async function.** No graph builder, no YAML, no visual editor. You write ordinary TypeScript with `if`, `for`, `while`, `await`, and early returns. The orchestrator runs the function top to bottom.

**2. A step is a reusable named constant.** You define a step once (what agent runs it, which skill to load, what it should produce, what it should return). You can invoke the same step many times with different overrides at the call site.

**3. `run(STEP)` is the only magic word.** Every `run()` call is spawned, observed, validated, and its result is **persisted by name**. Code between `run()` calls runs every time (so keep it idempotent). Code inside a `run()` call runs once per name and is cached from then on.

**4. Resume = re-execute the function, but `run()` returns cached values for names that already finished.** This is the same model Inngest and Restate use. It's boring and it works. It's also the single most important thing to internalize, because it shapes how you should structure your workflows.

Everything else — parallel, commit, custom steps, escalation, dry-run — is built on top of those four ideas.

---

## 3. Project layout

A typical workflow project looks like this:

```
my-project/
├── orchestration.ts      # your workflow function
├── steps.ts              # reusable step definitions
├── runners/              # (optional) custom agent wrappers
│   └── aider.ts
└── .orchestrator/        # created by orch; git-ignore this
    └── runs/
        └── <run-id>/
            ├── state.json      # memoized results, keyed by step name
            ├── steps/
            │   └── <step>.jsonl    # per-step event log
            └── transcripts/
```

You run workflows with the `orch` CLI from the project root.

---

## 4. The primitives

There are seven things you need to know. That's it.

### `step.define(name, config)`

Declares a reusable step. The name is the memoization key, so make it stable and meaningful.

```ts
import { step, claude, codex, fileProduced, gitDiffCreated, schema } from '@you/orch'
import { z } from 'zod'

export const PLAN = step.define('plan', {
  agent: claude({ model: 'claude-opus-4-6' }),
  skill: 'workflows:plan',
  returns: schema(z.object({
    phases: z.array(z.object({
      name: z.string(),
      files: z.array(z.string()),
      riskLevel: z.enum(['low', 'medium', 'high']),
    })),
  })),
  validate: fileProduced('docs/plans/*.md'),
})
```

Fields:
- **`agent`** — which runner to use. `claude()`, `codex()`, or your own. Pass options like `{ model, interactive, extraArgs }`.
- **`skill`** — (optional) Claude Code skill to load for this step.
- **`prompt`** — (optional) default prompt. Can be overridden at the call site.
- **`returns`** — (optional) a Zod schema. If set, the agent is spawned with `--json-schema` (Claude) or `--output-schema` (Codex) and the result is validated and returned as a typed value.
- **`validate`** — (optional) one validator or an array of them. Built-ins: `fileProduced(glob)`, `gitDiffCreated()`, `gitCommitCreated()`. Custom: inline `check(fn)` or reusable `defineValidator(name, fn)`. See §7 for examples. All must pass for the step to succeed.

### `workflow(name, fn)`

Wraps your workflow function. Gives you the `run` primitive as the first argument.

```ts
import { workflow } from '@you/orch'

export default workflow('feature-build', async (run) => {
  // your workflow here
})
```

### `run(STEP, overrides?)`

The only way to invoke a step. Returns the step's typed result (or `void` if no `returns` schema).

```ts
const plan = await run(PLAN, {
  prompt: 'Plan the auth refactor',
  extraContext: { ticketId: 'ENG-123' },
})
// plan is typed as { phases: [...] }
```

Every `run()` call is memoized under `STEP.name`. If you `run()` the same step twice in one workflow, give the second call a distinct name with `as:`:

```ts
await run(WORK, { as: 'work-auth' })
await run(WORK, { as: 'work-api' })
```

### `parallel(...)`

Deterministic concurrent execution. Two forms.

**Heterogeneous** — different steps at the same time:

```ts
const [claudeTake, codexTake] = await parallel([
  run(RESEARCH_CLAUDE, { prompt: 'Approach A: event-sourced auth' }),
  run(RESEARCH_CODEX,  { prompt: 'Approach B: stateless JWT with rotation' }),
])
```

**Homogeneous** — same step, different inputs:

```ts
const reviews = await parallel(
  ['security', 'performance', 'design'],
  (lens) => run(REVIEW, { as: `review-${lens}`, prompt: `Review focused on ${lens}` }),
)
```

Both forms take `{ concurrency: 3 }` to cap in-flight agents. Every branch gets a stable memoization key, so parallel runs are individually resumable.

> **A trap to avoid.** Don't parallelize work that has ordering constraints. Implementation phases (auth → api → ui) usually depend on each other. Use a plain `for` loop for sequence; use `parallel()` only for work that is *actually* independent.

### `commit(message)`

Creates a real git commit at the point you place it in the workflow. First-class so it shows up in dry-run, state.json, and the status pane.

```ts
await run(WORK, { as: 'work-auth' })
await commit('feat(auth): extract token service')
```

### `run.custom(name, fn)`

The escape hatch for arbitrary code that needs to be memoized like a step. Use it when you want to do something the agents can't do but you still want resume to work correctly.

```ts
const stats = await run.custom('post-process', async (ctx) => {
  const planDoc = await readFile(ctx.plan.path)
  return { tokenCount: countTokens(planDoc), lineCount: planDoc.split('\n').length }
})
```

Return value is typed, memoized, and visible in `orch status`.

### Validators (`validate:`)

Every step can declare one or more post-exit checks under `validate:`. They run after the agent exits. On failure, the orchestrator pops the tmux pane with the transcript and asks you: retry / skip / abort / edit-and-continue.

Built-ins are named as past-tense assertions so the call site reads like a sentence:

```ts
validate: fileProduced('docs/plans/*.md')   // at least one file matches
validate: gitDiffCreated()                   // non-empty diff since step start
validate: gitCommitCreated()                 // HEAD moved forward
validate: [fileProduced('docs/plans/*.md'), gitCommitCreated()]   // array — all must pass
```

Custom validators are covered in §7. The short version: `check(fn)` for inline one-offs, `defineValidator(name, fn)` for reusable project-specific checks like `testsPassed()`, `typecheckPassed()`, `migrationReversible()`.

**Why `validate:` and not `produces:`?** Because not every check is about a produced artifact. A step might need to assert that tests still pass, or that a migration is reversible, or that the returned plan has at least one phase. `validate:` covers all of those under one key — it's named for the *action* (we validate the step), not the noun.

---

## 5. Your first workflow (small, complete example)

Minimal workflow with three steps and no parallelism. Read this top to bottom — it's a complete program.

```ts
// steps.ts
import { step, claude, fileProduced, gitDiffCreated, schema } from '@you/orch'
import { z } from 'zod'

export const BRAINSTORM = step.define('brainstorm', {
  agent: claude({ interactive: true }),
  skill: 'brainstorming',
  validate: fileProduced('docs/brainstorms/*.md'),
})

export const PLAN = step.define('plan', {
  agent: claude({ model: 'claude-opus-4-6' }),
  skill: 'workflows:plan',
  returns: schema(z.object({
    phases: z.array(z.object({ name: z.string(), summary: z.string() })),
  })),
  validate: fileProduced('docs/plans/*.md'),
})

export const WORK = step.define('work', {
  agent: claude(),
  skill: 'workflows:work',
  validate: gitDiffCreated(),
})
```

```ts
// orchestration.ts
import { workflow, commit } from '@you/orch'
import { BRAINSTORM, PLAN, WORK } from './steps'

export default workflow('feature-build', async (run) => {
  await run(BRAINSTORM)
  const plan = await run(PLAN)

  for (const phase of plan.phases) {
    await run(WORK, {
      as: `work-${phase.name}`,
      prompt: `Implement ${phase.name}: ${phase.summary}`,
    })
    await commit(`feat(${phase.name}): ${phase.summary}`)
  }
})
```

Run it:

```bash
orch run orchestration.ts
```

What happens:
1. `orch` creates `.orchestrator/runs/<id>/` and a tmux session on a dedicated socket (`-L orchestrator`).
2. The left pane shows status: current step, elapsed time, running cost.
3. For each `run()` call, the orchestrator spawns the agent in the right pane (or headless), tails its transcript, waits for exit, runs `validate:` checks, parses `returns`, persists to `state.json`.
4. If `BRAINSTORM` is interactive, the right pane is a normal Claude Code session you talk to; when you `/exit`, the step completes.
5. The loop over `plan.phases` runs `WORK` once per phase with a stable name (`work-auth`, `work-api`, ...). Each one is individually resumable.
6. At the end, the summary prints and tmux exits (or stays open, your call).

That's the whole core loop. Everything below is "how do I do X on top of this."

---

## 6. Advanced: structured handoffs between steps

This is the feature that makes the whole thing type-safe. When you set `returns: schema(...)`, the orchestrator passes the schema to the agent (`--json-schema` for Claude, `--output-schema` for Codex), parses the structured output, validates against Zod, and returns a typed value from `run()`.

```ts
const PLAN = step.define('plan', {
  agent: claude(),
  returns: schema(z.object({
    phases: z.array(z.object({
      name: z.string(),
      files: z.array(z.string()),
      riskLevel: z.enum(['low', 'medium', 'high']),
    })),
    estimatedTokens: z.number(),
  })),
})

// Later...
const plan = await run(PLAN)           // typed — plan.phases is an array of { name, files, riskLevel }
const risky = plan.phases.filter(p => p.riskLevel === 'high')
```

No casts. If the agent returns something that doesn't match the schema, the step fails loudly and you get the usual retry/skip/abort/edit-and-continue prompt.

**Gotcha:** this uses primitives that only exist on `codex exec` (not interactive `codex`), and are only on Claude Code in certain flag combinations. The orchestrator picks the right flags per runner; you just declare the schema.

---

## 7. Advanced: custom validators

The built-ins (`fileProduced`, `gitDiffCreated`, `gitCommitCreated`) cover the common cases, but you'll frequently want project-specific checks: tests pass, typecheck is clean, the plan has at least one phase, the migration is reversible. Two flavors, for two situations.

### Inline one-off — `check(fn)`

For checks you only need once. The function gets a `ctx` object with the step name, working dir, the parsed `returns` value (if any), the artifact paths surfaced by other validators, the transcript path, and an `exec` helper for shelling out. Return `true` (or nothing) for pass; return a string or `{ ok: false, reason }` for fail.

```ts
import { step, claude, check, fileProduced, schema } from '@you/orch'
import { z } from 'zod'

export const PLAN = step.define('plan', {
  agent: claude(),
  returns: schema(z.object({
    phases: z.array(z.object({ name: z.string(), files: z.array(z.string()) })),
  })),
  validate: [
    fileProduced('docs/plans/*.md'),
    check(async (ctx) => {
      if (ctx.returns.phases.length === 0) return 'plan has no phases'
      if (ctx.returns.phases.some((p) => p.files.length === 0)) return 'a phase has no files'
      return true
    }),
  ],
})
```

Notice the `validate:` array — a step can have multiple validators and they *all* must pass. Also notice that `check()` can read `ctx.returns` to assert invariants on the parsed structured output. That's the point of keeping `returns:` and `validate:` as separate concerns: the schema parses and types, the validator asserts semantic facts.

### Reusable named check — `defineValidator(name, fn)`

As soon as a check shows up in a second step, lift it. `defineValidator` gives it a stable name that appears in logs, `state.json`, the tmux status pane, and failure prompts — so when it blows up, you know *which* check failed at a glance.

```ts
// validators.ts — project-specific validators, one file per project
import { defineValidator } from '@you/orch'

export const testsPassed = defineValidator('tests-passed', async (ctx) => {
  const { exitCode, stderr } = await ctx.exec('npm test')
  if (exitCode !== 0) return { ok: false, reason: `tests failed:\n${stderr.slice(-2000)}` }
  return { ok: true }
})

export const typecheckPassed = defineValidator('typecheck-passed', async (ctx) => {
  const { exitCode, stdout } = await ctx.exec('tsc --noEmit')
  if (exitCode !== 0) return { ok: false, reason: stdout.slice(-2000) }
  return { ok: true }
})

export const migrationReversible = defineValidator('migration-reversible', async (ctx) => {
  const migrations = ctx.artifacts.filter((p) => p.endsWith('.sql'))
  for (const m of migrations) {
    const res = await ctx.exec(`grep -q '^-- DOWN' ${m}`)
    if (res.exitCode !== 0) return { ok: false, reason: `${m} missing -- DOWN section` }
  }
  return { ok: true }
})
```

```ts
// steps.ts — reuse them across steps
import { step, claude, gitDiffCreated, fileProduced } from '@you/orch'
import { testsPassed, typecheckPassed, migrationReversible } from './validators'

export const WORK = step.define('work', {
  agent: claude(),
  validate: [gitDiffCreated(), typecheckPassed(), testsPassed()],
})

export const MIGRATION = step.define('migration', {
  agent: claude(),
  validate: [fileProduced('db/migrations/*.sql'), migrationReversible()],
})
```

### Two things to remember about validators

1. **Validators run once per successful step, not on resume.** When a step succeeds, its result is persisted to `state.json`. On `orch resume`, the cached result is returned immediately and validators do *not* run again. The post-exit state at success time is the fact of record. If you want a check to gate every resume, put it outside `run()` — or, better, wrap it in `run.custom()` so it gets its own memoized place in the chain.
2. **Validators are orthogonal to `returns:`.** `returns:` parses and types the agent's structured output. `validate:` asserts facts about the step's side effects, return value, or environment. They compose — a planner step often declares both.

---

## 8. Advanced: parallel work that actually pays off

The canonical use case for `parallel()` is **multi-agent research**: you have one question, and you want Claude and Codex to investigate different angles at the same time, then compare notes.

```ts
const [claudeAngle, codexAngle] = await parallel([
  run(RESEARCH_CLAUDE, { prompt: 'Research event-sourced auth' }),
  run(RESEARCH_CODEX,  { prompt: 'Research stateless JWT with rotation' }),
])

const plan = await run(PLAN, {
  extraPrompt: `Pick the best option.
    Claude's take: ${claudeAngle.summary}
    Codex's take: ${codexAngle.summary}`,
})
```

The second canonical use case is **parallel reviews** with different lenses:

```ts
const reviews = await parallel(
  ['security', 'performance', 'design'],
  (lens) => run(REVIEW, { as: `review-${lens}`, prompt: `Review focused on ${lens}` }),
)

const failing = reviews.filter(r => !r.passed)
if (failing.length > 0) {
  await run(WORK, {
    as: 'fix-review',
    extraPrompt: `Address: ${failing.flatMap(r => r.issues).join('\n')}`,
  })
}
```

Two things to notice:
1. `as: 'review-${lens}'` gives each parallel branch a stable name. If the run crashes after `review-security` finishes but during `review-performance`, resuming skips `review-security` and re-runs only the missing one.
2. The decision after `parallel()` is a plain JS `if`. No DSL for branching — you just have TypeScript. This generalizes: any time you'd reach for a "branch" primitive in a workflow engine, use plain JS instead.

---

## 9. Advanced: loops (retry-until-done)

Plain `while` works and is resumable, as long as the names inside are distinct per iteration.

```ts
let passed = false
let attempt = 0
while (!passed && attempt < 5) {
  await run(WORK, { as: `work-attempt-${attempt}` })
  const check = await run(REVIEW, { as: `check-${attempt}` })
  passed = check.passed
  attempt++
}
```

On resume, the iterations that completed before the crash return cached; the first unfinished one re-runs. There's also a helper — `loop({ while, maxIterations })` — that gives you an iteration counter in the status pane, but it's sugar; the `while` loop above is the real primitive.

---

## 10. Advanced: the non-obvious killer feature — resume from crash

Every `run()` call checks `.orchestrator/runs/<id>/state.json` for a cached entry under its name. Hit → return the cached value, skip execution. Miss → spawn the agent, persist the result, return.

```bash
# Start a run
orch run orchestration.ts
# Run ID: r-2026-04-09-a7f3

# Crash happens (power loss, CI timeout, you hit ctrl-c, whatever)

# Pick up where you left off
orch resume r-2026-04-09-a7f3
```

On resume, the workflow function re-executes from the top. Every `run()` call that previously completed returns instantly with the cached value. The first one that *didn't* complete actually spawns the agent. From there, execution continues normally.

**This is why the mental model matters.** Resume works because every `run()` call is memoized by name. Code outside `run()` calls is not memoized — it runs every time the function is re-executed. So **anything between `run()` calls must be idempotent or wrapped in `run.custom()`**. For example:

```ts
// BAD — writes the file twice on resume
await run(PLAN)
await fs.writeFile('plan-copy.md', 'snapshot')   // runs on every resume
await run(WORK)

// GOOD — wrapped so it's memoized
await run(PLAN)
await run.custom('snapshot-plan', async () => {
  await fs.writeFile('plan-copy.md', 'snapshot')
})
await run(WORK)
```

This is the one rule you genuinely need to remember. Everything else flows from it.

**What gets persisted:** the return value of each step (if it has one), its exit status, its produced artifacts (as paths, not contents), and the start/end timestamps. You can inspect any run with `orch status <run-id>`.

---

## 11. Advanced: dry-run before you burn tokens

Two flavors.

**Static pre-scan** — `orch dry-run orchestration.ts` walks the workflow function (stubbing every `run()` call with a recording Proxy) and prints the linear skeleton.

```
$ orch dry-run orchestration.ts
feature-build:
  1. brainstorm            [claude, interactive] → docs/brainstorms/*.md
  2. plan                  [claude] → plan.phases[]
  3. work-<phase>          [claude] × N (N = plan.phases.length)
  4. commit <phase>
```

Lossy on branches — a stub replay only goes down one side of an `if`. It's a "yep, that's what I want to run" sanity check, not a proof.

**Dynamic post-plan rendering** — after the planning step completes, the plan is persisted under a well-known key (`plan.v1`) and `orch status <run-id>` renders a tree with the actual known phases expanded. This is where the *journaled plan* pattern earns its keep: you see the real DAG after planning, not just the skeleton.

---

## 12. Observability: what you see while it runs

### Run modes — where views render

`orch` ships three run modes (v1 wires only `plain` and `two-pane`; `single-pane` is reserved for v2):

| Mode | When it fires | What you see |
|---|---|---|
| `plain` | `CI=true`, piped, no-TTY, or `--mode=plain` | `[orch] step:start plan` / `[plan] assistant> …` lines on stdout. `--format=json` emits one NDJSON envelope per event — structured for log ingestion. |
| `two-pane` | TTY + tmux ≥ 3.2, or `--mode=two-pane` | Dedicated tmux session on `-L orch-<runId>`: left = status rollup, right = active step's view. **orch auto-attaches your terminal to the session immediately** — you see both panes the moment the run starts. Interactive steps take the right pane via `tmux respawn-pane -k`; autonomous steps stream a readable transcript. |
| `single-pane` | *(v2 — deferred)* | Alt-screen TUI. Explicit `--mode=single-pane` exits 2 in v1 with the deferral message; autodetect never picks it. |

Resolution precedence: `--mode=<x>` > `orch.config.ts` `defaultMode` > `CI=true → plain` > TTY + tmux ≥ 3.2 → `two-pane` > fallback `plain`. The first-run banner prints on stderr with the chosen mode + why, unless `--format=json` suppresses stdout-noise for log consumers.

#### Detach, `--no-attach`, and nested tmux

- **Detach.** Press `Ctrl-b d` inside the tmux UI. orch prints `[orch] detached. run continues in background.` with `tmux … attach` and `orch logs <runId>` hints. The workflow keeps running in the same orch process until it completes.
- **`--no-attach`.** Skip auto-attach entirely — orch creates the session, prints the "attach with …" hint, and runs to completion without taking the TTY. Use for CI, screenshot scripts, and any case where you want to attach manually from a second terminal. Pairing `--mode=two-pane --no-attach` is the supported way to run two-pane on a headless box (no TTY required).
- **Nested tmux.** Running orch from inside a tmux session fails fast (`$TMUX` detected) — auto-attach inside nested tmux routes the client to the outer server and produces a confusing cascade. Escape options in the error message: attach from a pane, run orch outside tmux, or `--mode=plain`.

### `two-pane` — the tmux layout

`--mode=two-pane` uses tmux on a dedicated socket (`tmux -L orchestrator`) so it doesn't clobber your own tmux sessions. Two panes:

- **Left — status pane.** Persistent. Shows current step, elapsed time, running token count, running cost, the list of completed/pending steps, and any pending escalation. Orchestrator paints this; agents never touch it.
- **Right — agent pane.** Either (a) an interactive agent TUI you talk to directly, or (b) a live pretty-printed stream of tool calls for headless steps. Stays open after failure (`remain-on-exit on`) so you can read the transcript.

### What the panes actually look like

Here's the layout mid-run, during the `work-auth` step of the first-workflow example from §5:

```
┌─ orch: feature-build ── r-2026-04-09-a7f3 ──────────┬─ work-auth @ claude --bare -p ── alive 0:42 ───────────┐
│                                                      │                                                          │
│  ● brainstorm            ✓   3m 12s   $0.42   12k   │  system: loaded skill workflows:work                    │
│  ● plan                  ✓   1m 47s   $0.88   28k   │  system: allowed tools Bash, Read, Edit, Write           │
│  ● work-auth             ⟳   0m 42s   $0.12    6k   │                                                          │
│    └ tool: Edit(src/auth/token.ts)                   │  > I'll implement the auth token service. Reading the   │
│  ○ commit feat(auth)                                 │    existing module first...                              │
│  ○ work-api                                          │                                                          │
│    commit feat(api)                                  │  ◇ Read(src/auth/index.ts)                              │
│  ○ work-ui                                           │    → 23 lines                                            │
│    commit feat(ui)                                   │                                                          │
│                                                      │  ◇ Read(src/auth/session.ts)                            │
│  ─── totals ───                                      │    → 118 lines                                           │
│   elapsed   5m 41s                                   │                                                          │
│   cost      $1.42                                    │  > Adding TokenService with rotation support.            │
│   tokens    46,218 in / 81,176 out                   │                                                          │
│                                                      │  ◇ Edit(src/auth/token.ts)                              │
│  ─── escalation ───                                  │    + export class TokenService {                         │
│   (none pending)                                     │    +   constructor(private readonly clock: Clock) {}     │
│                                                      │    +   issue(userId: string): SignedToken { … }          │
│  ─── keys ───                                        │                                                          │
│   [d] detach   [r] pop right pane                    │  ◇ Bash(pnpm test -- auth/token)                        │
│   [s] status   [q] graceful stop                     │    PASS  src/auth/token.test.ts (3 tests, 412ms)         │
│   [!] force kill current step                        │                                                          │
│                                                      │  (streaming…)                                            │
└──────────────────────────────────────────────────────┴──────────────────────────────────────────────────────────┘
 [status]  run r-2026-04-09-a7f3 · step 3/9 work-auth · $1.42 · 5m41s · press ? for help
```

The glyphs on the left pane, top to bottom:

| Glyph | Meaning |
|---|---|
| `●` | step has started (running or finished) |
| `○` | step is pending (not yet reached in the workflow function) |
| `✓` | step completed, all `validate:` checks passed, result persisted |
| `⟳` | step currently running |
| `✗` | step failed (validator fail, agent error, max turns/budget) |
| `↯` | step suspended waiting for human input (escalation) |
| `↺` | step returned from cache on this invocation (during `orch resume`) |
| `└ tool: …` | most recent tool call under the current step, for liveness |

### What an escalation moment looks like

When a step needs a human decision (see §13), the `escalation` block on the left activates and the right pane hosts the prompt:

```
┌─ orch: feature-build ── r-2026-04-09-a7f3 ──────────┬─ [ human input needed ] ── work-auth ──────────────────┐
│                                                      │                                                          │
│  ● brainstorm            ✓   3m 12s   $0.42   12k   │  work-auth is about to run:                              │
│  ● plan                  ✓   1m 47s   $0.88   28k   │                                                          │
│  ● work-auth             ↯   2m 18s   $0.34   14k   │    Bash(pnpm prisma migrate deploy)                      │
│    └ awaiting decision                               │                                                          │
│  ○ commit feat(auth)                                 │  Reason: tool call matched escalation rule              │
│  ○ work-api                                          │    `Bash(pnpm prisma migrate deploy)` is in the          │
│                                                      │    defer list for this step.                            │
│  ─── escalation ───                                  │                                                          │
│   work-auth  prisma migrate deploy                   │  Context (last 20 lines of transcript):                  │
│   waiting 0m 14s                                     │    > Applied schema change, running migration now…     │
│                                                      │    > This will drop the deprecated sessions_v1 table.   │
│  ─── keys ───                                        │                                                          │
│   [d] detach   [r] pop right pane                    │  [a] allow    [d] deny + feedback    [e] edit + allow  │
│   [s] status   [q] graceful stop                     │  [x] abort run                                           │
└──────────────────────────────────────────────────────┴──────────────────────────────────────────────────────────┘
```

### What a failed-validator moment looks like

When `validate:` fails, the right pane shows which validator failed (by its `defineValidator` name) and the last lines of transcript:

```
┌─ orch: feature-build ── r-2026-04-09-a7f3 ──────────┬─ [ validation failed ] ── work-auth ────────────────────┐
│                                                      │                                                          │
│  ● brainstorm            ✓   3m 12s   $0.42   12k   │  Validator failed: tests-passed                         │
│  ● plan                  ✓   1m 47s   $0.88   28k   │                                                          │
│  ● work-auth             ✗   4m 02s   $0.71   22k   │    FAIL  src/auth/token.test.ts                          │
│    └ tests-passed failed                             │      ✕ rotates tokens on expiry (18ms)                  │
│  ○ commit feat(auth)                                 │        Expected: "rotated-123"                          │
│                                                      │        Received: undefined                              │
│  ─── totals ───                                      │                                                          │
│   elapsed   9m 01s                                   │  Transcript tail: .orchestrator/runs/.../work-auth.jsonl│
│   cost      $2.01                                    │                                                          │
│                                                      │  [r] retry step    [s] skip      [a] abort run          │
│                                                      │  [e] edit prompt + retry                                │
└──────────────────────────────────────────────────────┴──────────────────────────────────────────────────────────┘
```

### Tailing the raw stream

The left pane is a pretty-printer. For ground truth — every tool call argument, every token, every hook event — tail the NDJSON:

```bash
tail -f .orchestrator/runs/<id>/steps/<step>.jsonl
```

Each step mirrors Claude's `stream-json` or Codex's `ThreadEvent` NDJSON into its own file, so you can post-process, replay, or diff across runs.

### A detail worth knowing

The left pane is redrawn from `state.json` plus a small in-memory tail buffer, *not* from tmux scrollback. That's why `orch status <run-id>` from a different terminal can render the same view for a run that isn't currently visible anywhere — useful for resume and for checking on background runs.

---

## 13. Advanced: escalation to human

Some steps genuinely need a human decision — "which of these two approaches?", "the plan risks data loss, approve?", "tests fail in an unexpected way, should we proceed?". The unified API is:

```ts
// Inside a custom step or a runner callback:
const answer = await orch.requestHumanInput(
  'The plan modifies the users table. Approve?',
  { plan, migrationSql },
)
```

The orchestrator pops a tmux pane with the reason and context, waits for your answer, and returns it. Under the hood, the wiring is different for Claude and Codex — and this is worth knowing about because it's the part of the system that's hardest to get right:

- **Claude Code** has a rich, layered escalation model. The primary path is a `PreToolUse` hook that returns `permissionDecision: "defer"`, which is the documented async escalation primitive (v2.1.89+, non-interactive only). Secondary path is `--permission-prompt-tool` pointing at our MCP server.
- **Codex** is sparse — no `--permission-prompt-tool` equivalent, `codex_hooks` is a feature flag that isn't production-ready, and MCP elicitation is currently auto-cancelled in `codex exec` mode (open regression). So for Codex we do it two ways: (a) a blocking MCP tool with a one-hour timeout that waits on a file/socket, and (b) structure long Codex flows as multiple short `codex exec` calls with `--output-schema` returning `{ status: "done" | "needs_human", question? }`, and the orchestrator handles the gap between calls.

You, the workflow author, don't see any of this. You just call `orch.requestHumanInput(...)`. But it's worth knowing the Codex path is genuinely thin, and for critical decision points, Codex steps should be short-run with structured output rather than long interactive sessions.

---

## 14. Advanced: wrapping a new agent (the Runner interface)

This is a first-class, v1-day-one primitive — not a plugin afterthought. `claude()` and `codex()` are built on the same public API you'd use. A runner is ~30 lines.

```ts
// runners/aider.ts
import { defineRunner } from '@you/orch/runner'

export const aider = defineRunner({
  name: 'aider',
  supports: { interactive: true, structuredOutput: false },

  buildCommand: (ctx) => ({
    argv: [
      'aider',
      '--yes-always',
      '--message', ctx.prompt,
      ...ctx.files,
    ],
    env: { ...process.env, OPENAI_API_KEY: ctx.secrets.OPENAI_API_KEY },
  }),

  parseEvents: (line) => {
    if (line.includes('Applied edit to')) return { type: 'tool-call', tool: 'edit' }
    if (line === '> ') return { type: 'turn-complete' }
    return null
  },

  extractStructuredOutput: () => {
    throw new Error('aider does not emit structured output')
  },
})
```

Then use it in a step:

```ts
import { aider } from './runners/aider'

export const FIX = step.define('fix', {
  agent: aider({ model: 'gpt-4' }),
  validate: gitDiffCreated(),
})
```

The `RunnerContext` you get in `buildCommand` gives you the working dir, env, per-step prompt, structured-output schema (if any), tmux pane handle, transcript file path, and escalation wiring — so you only write CLI-specific glue.

In v1, there's no npm-package registry for runners. You drop them in `./runners/` and import them directly. Simpler, easier to debug, zero versioning drama.

---

## 15. CLI cheat sheet

```bash
orch run <file.ts>             # start a new run
orch resume <run-id>           # resume the named run from where it crashed
orch runs                      # list all runs with status
orch status <run-id>           # show the current/final state of a run
orch dry-run <file.ts>         # print the linear skeleton without executing
```

There's no `orch init` — you just create `orchestration.ts` and `steps.ts` by hand. There's no `orch login` — each runner uses its own auth (`claude auth`, `codex login`).

---

## 16. The rules you actually need to remember

This is the short list of things that will bite you if you forget them.

1. **Anything between `run()` calls must be idempotent**, or wrap it in `run.custom(name, fn)`. This is the one non-obvious constraint from the resume model.
2. **Give repeat `run()` calls a distinct `as:` name.** `run(WORK)` twice without `as:` is an error.
3. **Don't parallelize work that has ordering constraints.** Use a plain `for` loop. `parallel()` is for genuinely independent work.
4. **Interactive steps are Claude-only in v1.** Codex doesn't have a programmatic escalation path from its interactive TUI, so Codex steps are headless — either one-shot `codex exec` or orchestrator-mediated chains.
5. **Structured outputs use `codex exec`, not `codex` or `codex resume`.** This is a Codex CLI limitation, not ours. The orchestrator picks the right invocation automatically; just don't expect `returns:` to work in an interactive Codex step (there are no interactive Codex steps in v1 anyway).
6. **If your workflow function grows past ~100 lines, split it.** The DSL is just TypeScript, so you *can* write a 400-line workflow. Don't. Pull steps into `steps.ts`, pull helpers into their own files, or use presets.
7. **Resume is per-step, not per-line.** A run that crashed mid-step re-runs that step from scratch. Design steps to be re-runnable.

---

## 17. What this is not (to calibrate expectations)

- **Not a determinism engine.** Temporal requires the whole workflow function to be deterministic. We don't — you can use `Date.now()`, random IDs, etc. between `run()` calls. The cost is that those lines run every time on resume, which is why rule #1 above matters.
- **Not a hive-mind.** There is no agent deciding which agent runs next. The workflow is a static skeleton; only explicit `routeWith(llm, ...)` branches (which are opt-in and rare) give control to the model.
- **Not a visual tool.** There's a Mermaid graph output planned for `orch graph`, but it's could-have, not must-have. The primary interface is the TS file.
- **Not an npm registry for runners.** You write runners as files next to your workflow.
- **Not opinionated about prompts.** We don't ship a "library of best-practice prompts." You bring your own skills, your own prompts, your own opinions. The orchestrator just sequences them.

---

## 18. Open questions (where we'd like your review)

These are the decisions that are not yet locked in. If you have opinions on any of them, now is the time to say so.

1. **Project name.** "claude-orchestrator" is misleading (Codex is first-class). Candidates: `orch`, `conduit`, `forge`, `chain`, `dispatch`, `teammate`.
2. **Which Claude Code escalation primitive to lead with** — `PreToolUse` hook with `permissionDecision: "defer"` (cleanest, non-interactive only) vs `--permission-prompt-tool` MCP route vs the first-class `PermissionRequest`/`Elicitation` hook events. Likely answer: lead with the `PreToolUse` hook, expose the MCP route as an escape hatch.
3. **Bun vs Node default.** Picked Bun for speed and native TS. May flip to Node+tsx if `node-pty` turns out to be load-bearing for headless steps.
4. **Worktree-per-run isolation.** Clean, but complicates resume (where does state live?). Probably v2, not v1.
5. **Claude Agent SDK vs CLI subprocess.** Picked subprocess for isolation and language-agnosticism. SDK may be cleaner for orchestrator-internal short classification calls. Possible hybrid.
6. **Journaled plan key.** Persisted under `plan.v1` so the status pane can render the DAG after planning completes. Is this the right shape? Do we want multiple plans per run?
7. **Skill scoping per step.** Likely `.orchestrator/runs/<id>/skills/<step>/SKILL.md` + `--add-dir`, but the auto-loading behavior of `.claude/skills/` from added dirs is under-documented. Needs an empirical check.

---

## 19. Where to go next

- **`docs/brainstorms/2026-04-08-claude-orchestrator-brainstorm.md`** — the full brainstorm with the decision audit, competitor comparison, risk list, and verified CLI recipes. Read this if you want the "why" behind the decisions in this doc.
- **Next planned doc:** an architecture plan with file structure, data model, and phase breakdown. Not written yet.

---

*If after reading this you can explain to a teammate (a) what a step is, (b) what `run()` does, (c) why resume works, and (d) when to use `parallel()` vs a `for` loop — this doc did its job.*
