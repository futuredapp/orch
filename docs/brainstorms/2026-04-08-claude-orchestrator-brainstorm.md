---
date: 2026-04-08
status: brainstorm
topic: Code-first orchestrator for chaining coding-agent CLIs (Claude Code, Codex)
audited: 2026-04-08 — every Claude Code and Codex CLI claim in this doc has been verified against primary sources (claude docs, openai/codex source on main, live `claude --help` and `codex --help` output). See Appendix for doc URLs. Non-obvious gotchas surfaced by the audit: `claude --help` does not list every flag (e.g. `--permission-prompt-tool`, `--json-schema`, `--max-turns` are real but absent from help); Codex `--output-schema` is only on `codex exec` and requires codex-cli >= 0.118.0; Codex `codex_hooks` is behind a `under development` feature flag and is NOT comparable to Claude Code's production hooks; Codex has no `--permission-prompt-tool` equivalent and MCP elicitation is currently auto-cancelled in `codex exec` mode (open regression #16685 at v0.118.0).
---

# Claude Orchestrator — Brainstorm

## TL;DR

A dead-simple, code-first orchestrator that chains coding-agent CLIs — Claude Code and Codex — through deterministic workflows (brainstorm → plan → work → review) with tmux observability and human-in-the-loop only at critical moments. You write the workflow as a plain TypeScript async function that reads like pseudocode; the orchestrator handles process lifecycle, typed data handoffs between steps, artifact validation, escalation to the human, and crash-resume via name-keyed memoization. First-class support for Claude Code and Codex on day one, extensible to any CLI agent via a small `Runner` interface.

## Why build this

**The repeatable workflow problem.** A typical compound-engineering session is already a deterministic chain: `brainstorm → document-review → plan → deepen-plan → document-review-plan → work (phases) → review → apply → codex-review → ship`. Each transition is *"yes, do the next one"* — the human is the bottleneck, not a decision-maker.

**What's wrong with existing solutions.** Research surfaced ~10 Claude-Code orchestrators. None combine all six things the workflow actually needs:

| Feature | claude-flow | claude-squad | agent-teams | claude-workflow | claude-agent-sdk | **us** |
|---|---|---|---|---|---|---|
| Declarative code DSL | ✗ | ✗ | ✗ | yaml | ✗ | **✓** |
| Typed JSON handoffs between steps | ✗ | ✗ | ✗ | ✗ | ✓ | **✓** |
| Reusable named steps with overrides | ✗ | ✗ | partial | ✗ | ✗ | **✓** |
| Dry-run / print chain before executing | ✗ | ✗ | ✗ | ✗ | ✗ | **✓** |
| tmux split-pane observability | via TUI | ✓ | ✓ | web UI | ✗ | **✓** |
| First-class multi-CLI (Claude + Codex) | ✓ | ✓ | ✗ | ✗ | ✗ | **✓** |
| Public `Runner` interface — wrap any new CLI in ~30 lines | ✗ | ✗ | ✗ | ✗ | ✗ | **✓** |

The biggest ecosystem gap: **Anthropic's Agent SDK exposes `outputFormat` for typed structured outputs, but nobody has wired it into a workflow DSL.** That's the differentiating primitive we'll build around.

**What we're explicitly not building:** a hive-mind. claude-flow/ruflo is the cautionary tale — 310 MCP tools, 27 hooks, distributed consensus algorithms to decide which agent types next. We build the boring, deterministic thing that covers 90% of real workflows and nothing else.

## Core concept — how the API reads

The workflow is a plain async function. Steps are reusable constants. Data flows through normal TypeScript variables. Every step has a stable name; results are persisted by name; resume skips names with cached results. Host-language `if`/`for`/`while` handles all sequential control flow; one `parallel()` helper gives concurrent execution with deterministic naming.

```ts
// steps.ts — steps are reusable named constants with default config
import { step, claude, codex, fileProduced, gitDiffCreated, schema } from '@you/orch'
import { z } from 'zod'

export const BRAINSTORM = step.define('brainstorm', {
  agent: claude({ interactive: true }),
  skill: 'brainstorming',
  validate: fileProduced('docs/brainstorms/*.md'),
})

// Two research steps that use different runners — designed to be invoked in
// parallel to compare angles on the same question.
const researchReturns = schema(z.object({ summary: z.string(), risks: z.array(z.string()) }))

export const RESEARCH_CLAUDE = step.define('research-claude', {
  agent: claude({ model: 'claude-opus-4-6' }),
  returns: researchReturns,
})

export const RESEARCH_CODEX = step.define('research-codex', {
  agent: codex({ model: 'gpt-5.4' }),
  returns: researchReturns,
})

export const PLAN = step.define('plan', {
  agent: claude({ model: 'claude-opus-4-6' }),
  skill: 'workflows:plan',
  // Structured output via Claude --json-schema or Codex --output-schema
  returns: schema(z.object({
    phases: z.array(z.object({
      name: z.string(),
      files: z.array(z.string()),
      riskLevel: z.enum(['low', 'medium', 'high']),
    })),
  })),
  validate: fileProduced('docs/plans/*.md'),
})

export const WORK = step.define('work', {
  agent: claude(),
  skill: 'workflows:work',
  validate: gitDiffCreated(),
})

export const REVIEW = step.define('review', {
  agent: codex({ model: 'gpt-5.4' }),
  prompt: 'Review the diff against the plan.',
  returns: schema(z.object({
    passed: z.boolean(),
    issues: z.array(z.string()),
  })),
})
```

```ts
// orchestration.ts — the workflow itself
import { workflow, parallel, commit } from '@you/orch'
import { BRAINSTORM, PLAN, RESEARCH_CLAUDE, RESEARCH_CODEX, WORK, REVIEW } from './steps'

export default workflow('feature-build', async (run) => {
  await createWorktree('feature-build')

  await run(BRAINSTORM)

  // Parallel research — two agents tackle the same question from different angles
  // at the same time. Heterogeneous parallel: each call is a different step.
  const [claudeTake, codexTake] = await parallel([
    run(RESEARCH_CLAUDE, { prompt: 'Research approach A: event-sourced auth' }),
    run(RESEARCH_CODEX,  { prompt: 'Research approach B: stateless JWT with rotation' }),
  ])

  const plan = await run(PLAN, {
    extraPrompt: `Pick the best option. Claude's take: ${claudeTake.summary}. Codex's take: ${codexTake.summary}.`,
  })

  // Implementation phases are typically dependent (auth → api → ui), so a plain
  // for-loop is the honest default. No magic; just normal TypeScript.
  for (const phase of plan.phases) {
    await run(WORK, {
      as: `work-${phase.name}`,                       // disambiguates repeated step
      prompt: `Implement ${phase.name}: ${phase.files.join(', ')}`,
      extraContext: phase,
    })
    await commit(`feat(${phase.name}): ${phase.summary}`)
  }

  // Parallel reviews — three independent reviewers at the same time. Homogeneous
  // fan-out: same step called with different inputs.
  const reviews = await parallel(
    ['security', 'performance', 'design'],
    (lens) => run(REVIEW, { as: `review-${lens}`, prompt: `Review focused on ${lens}.` }),
  )

  // Host-language branching — plain if/else, no DSL primitive needed
  const failing = reviews.filter((r) => !r.passed)
  if (failing.length > 0) {
    await run(WORK, {
      as: 'fix-review',
      extraPrompt: `Address: ${failing.flatMap((r) => r.issues).join('\n')}`,
    })
    await commit('fix: review feedback')
    await run(REVIEW, { as: 'final-review' })
  }
})
```

Why this shape works: it keeps the **user's original instinct** (`run(PLAN)` as the invocation, steps as reusable named constants, overrides at the call site) while adopting **Inngest/Restate's name-keyed memoization model** for resumability and **Claude Agent SDK's `outputFormat`** for typed handoffs. The workflow function runs once; every `run()` call persists its result under its name; on resume the function re-executes but `run()` returns cached values for completed names.

### Extensibility is a v1 primitive — wrapping a new agent is ~30 lines

Adding a new agent CLI is **not** a plugin afterthought; it's the same surface `claude()` and `codex()` are built on. A `Runner` is a small interface — four methods — and the orchestrator gives you a typed `RunnerContext` (working dir, env, per-step prompt, structured-output schema, tmux pane handle, transcript tailing, escalation wiring) so you only write the CLI-specific glue.

```ts
// runner.ts — the interface users implement to add a new agent
export interface Runner {
  name: string                               // 'claude' | 'codex' | 'aider' | ...
  supports: { interactive: boolean; structuredOutput: boolean }

  // How to spawn the CLI. Receives normalized config, returns argv + env.
  buildCommand(ctx: RunnerContext): { argv: string[]; env: Record<string, string> }

  // How to detect end-of-run from the process's stdout stream.
  parseEvents(line: string): RunnerEvent | null   // { type: 'turn-complete' | 'error' | 'tool-call' | ... }

  // How to extract the typed return value when a schema was requested.
  extractStructuredOutput(finalEvent: RunnerEvent, schema: ZodSchema): unknown

  // Optional: how the runner signals 'human input needed' back to the orchestrator.
  escalationWiring?(ctx: RunnerContext): EscalationBinding
}
```

```ts
// example: wrapping Aider in under 30 lines
import { defineRunner } from '@you/orch/runner'

export const aider = defineRunner({
  name: 'aider',
  supports: { interactive: true, structuredOutput: false },  // Aider has no --json-schema

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
    if (line === '> ')                    return { type: 'turn-complete' }
    return null
  },

  extractStructuredOutput: () => { throw new Error('aider does not emit structured output') },
})

// And in steps.ts:
export const FIX = step.define('fix', { agent: aider({ model: 'gpt-4' }), validate: gitDiffCreated() })
```

The built-in `claude()` and `codex()` factories are implemented on top of the same `defineRunner` primitive — there is no privileged path. This is why "add Amp / Ollama / a local tool" is a must-have, not a v2 plugin system. What we **don't** expose in v1 is a registry for third-party npm packages; users drop their runner file in `./runners/` and import it directly.

## Key decisions (locked from Q&A + research)

1. **Hybrid control flow.** Static code skeleton; LLM routing only at explicit branches (`branch({ route: llm(...) })` escape hatch, rare).
2. **TypeScript on Bun.** Users author `orchestration.ts`; orchestrator executes via Bun. Node+tsx fallback. Node-pty concern is neutralized because agents spawn inside tmux panes.
3. **Tmux split layout from day 1.** Dedicated socket `-L orchestrator`. Left status pane (persistent) + right agent pane (on-demand, auto-close).
4. **Agent process exit = step done** for interactive steps. `/exit` in Claude Code, `/quit` in Codex. Detected via `#{pane_dead}` polling + `pane-died` hook.
5. **Escalation to human — runner-specific, with a unified interface.** One orchestrator API (`orch.requestHumanInput(reason, context)`), but the wiring differs per runner because Claude Code and Codex have very different primitives (see *How it handles the hard cases → Escalation* below for the full explanation). The short version:
   - **Claude Code:** primary path is a `PreToolUse` hook with `permissionDecision: "defer"` (v2.1.89+, non-interactive only) — the documented async escalation primitive. Secondary: `--permission-prompt-tool` pointing at an orchestrator MCP tool. Sibling side-channel: `Notification` hook with `permission_prompt` / `idle_prompt` matcher for alerts (not decisions).
   - **Codex:** there is **no equivalent** to `--permission-prompt-tool`. The only viable pattern is a blocking MCP tool (`orch__request_human_input`) exposed via `~/.codex/config.toml` with a generous `tool_timeout_sec` (~3600), prompt-engineered into the agent's system prompt. **Plus** an active regression (#16685 at v0.118.0) where MCP elicitation is auto-cancelled in `codex exec` — which means for Codex we also support an alternative architecture: structure long flows as multiple short `codex exec` calls with orchestrator-driven decisions between them, using `--output-schema` to extract "I need human input" signals from the final message.
6. **Per-step validators under a single `validate:` key.** The key is named for what it does — *validate the step* — not for what the step produces. Built-in validators are named as past-tense assertions: `fileProduced(glob)`, `gitDiffCreated()`, `gitCommitCreated()`. `validate:` accepts a single validator or an array (all must pass). Custom logic comes in two shapes: inline `check(async (ctx) => ...)` for one-offs, and `defineValidator('name', fn)` for reusable project-specific assertions (e.g. `testsPassed()`, `typecheckPassed()`, `migrationReversible()`). Validators run after the agent exits; failure pops the right pane with transcript + error and asks: retry / skip / abort / edit-and-continue.
7. **Explicit `commit()` step.** Git commits are first-class chain entries you place where you want them.
8. **Resumable runs.** `.orchestrator/runs/<id>/state.json` persists each step's outcome + structured returns. `orch resume <id>` re-executes the function; `run()` calls skip completed names.
9. **Step config flexibility.** Inline object literals, external config files, and preset helpers (`brainstormPreset()`) all work — users pick whichever feels right.
10. **CLI entry point.** `orch run <file.ts>`, `orch resume <id>`, `orch runs`, `orch status`, `orch dry-run <file.ts>`.
11. **Both Claude Code and Codex on day one — and the `Runner` interface is the same primitive third parties use to add their own.** `claude()` and `codex()` are not privileged; they're built on the public `defineRunner()` API. Wrapping Aider, Amp, Ollama, or any new CLI is ~30 lines and lives next to the workflow. `extraArgs` escape hatches handle runner-specific flags without widening the core interface.
12. **Journaled plan pattern.** Structured outputs from planning-shaped steps are persisted under a well-known key (`plan.v1`) so the status pane and dry-run can render the post-plan DAG.

## How it handles the hard cases

### 1. Passing typed values between steps

Claude Code: `--json-schema '<schema>'` with `--output-format json` emits a validated `structured_output` field on the final `result` envelope. Codex: `--output-schema <file>` (available only on `codex exec`, not on interactive `codex` or `codex resume`) — the final `agent_message` item's text is schema-conformant JSON, and you can pair it with `-o <file>` to get the bare final message directly. Our `returns: schema(z.object({...}))` picks the right flag per runner and parses the output into the value that `await run(STEP)` yields. Fully typed, Zod-validated. No cast.

### 2. Parallel execution — genuinely independent work

`parallel()` handles two shapes, both of which are just `Promise.all` with deterministic naming and resume support.

**Heterogeneous** — several different steps at once. The canonical use case is multi-agent research: Claude and Codex investigate different angles simultaneously and their outputs feed into a decision step.

```ts
const [claudeTake, codexTake] = await parallel([
  run(RESEARCH_CLAUDE, { prompt: 'Investigate event-sourced auth' }),
  run(RESEARCH_CODEX,  { prompt: 'Investigate stateless JWT + rotation' }),
])
```

**Homogeneous** — the same step called with different inputs. Canonical use case: parallel reviews (security + performance + design lenses), or parallel doc generation per module.

```ts
const reviews = await parallel(
  ['security', 'performance', 'design'],
  (lens) => run(REVIEW, { as: `review-${lens}`, prompt: `Review focused on ${lens}.` }),
)
```

Both forms take an optional `{ concurrency: 3 }` to cap simultaneous agents. Every call gets a stable name (explicit `as:` for homogeneous; the step's name for heterogeneous), so every parallel branch is independently memoizable and resumable.

**A deliberate non-example: sequential implementation phases.** Implementation phases usually depend on each other (auth must exist before the API that uses it). Parallelizing them is a trap. The honest default is a plain `for` loop — which is exactly what the core example in this doc shows. `parallel()` is for work that's *actually* independent. If you're tempted to parallelize work that has ordering constraints, don't; the DX cost of debugging a race is much higher than the latency you save.

Stolen from Temporal/Inngest (plain JS loops for sequence, primitive helper only for parallel) and Trigger.dev's typed per-item destructuring DX.

### 3. Conditional branching

Plain TypeScript `if`/`else` inside the workflow function. No DSL primitive. This works because resumability is per-step (name-keyed memoization), not per-graph-edge. Unlike Dagster/Airflow, we never paid the "branching needs a primitive" tax.

For LLM-routed branches, a `routeWith(llm, ...)` helper is available as opt-in, but 95% of flows use plain `if`.

### 4. Custom logic inside a step

```ts
await run.custom('post-process', async (ctx) => {
  const planDoc = await readFile(ctx.plan.path)
  return { tokenCount: countTokens(planDoc) }
})
```

`run.custom` is the escape hatch: an inline step with arbitrary code. Its return value is typed, memoized, and shows up in resume state like any other step.

### 5. Loops (retry-until-done)

```ts
let done = false
let attempt = 0
while (!done && attempt < 5) {
  await run(WORK, { as: `work-attempt-${attempt}` })
  const check = await run(REVIEW, { as: `check-${attempt}` })
  done = check.passed
  attempt++
}
```

Plain `while`. Stable names (`work-attempt-0`, `work-attempt-1`) make every iteration individually resumable. A `loop({ maxIterations, until })` helper is available for the common case with built-in iteration tracking in the status pane.

### 6. Validating step output — `validate:` and custom validators

Every step can declare one or more post-exit checks under a single `validate:` key. Built-ins are named as past-tense assertions so the call site reads like a sentence:

```ts
validate: fileProduced('docs/plans/*.md')      // at least one file matches the glob
validate: gitDiffCreated()                      // working tree has a non-empty diff vs. pre-step state
validate: gitCommitCreated()                    // HEAD moved forward since step start
validate: [fileProduced('docs/plans/*.md'), gitCommitCreated()]   // all must pass
```

`validate:` is deliberately named for the *action* (we validate the step), not the noun (what the step produces). That lets it cover checks that aren't about output artifacts at all — type checks, test runs, migration reversibility — under the same key.

**Inline custom check — `check(fn)`.** The one-off escape hatch. The function gets a `ctx` with the step name, working dir, return value (if any), artifact paths, transcript path, and an `exec` helper. Return `true` (or nothing) for pass; return a string or `{ ok: false, reason }` for fail.

```ts
import { check } from '@you/orch'

export const PLAN = step.define('plan', {
  agent: claude(),
  returns: schema(planSchema),
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

**Reusable custom validator — `defineValidator(name, fn)`.** Once a check shows up in more than one step, lift it with `defineValidator`. The `name` shows up in logs and the status pane, so failures are diagnosable at a glance.

```ts
// validators.ts
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
  // ctx.artifacts contains paths surfaced by other validators (e.g., fileProduced)
  const migrations = ctx.artifacts.filter((p) => p.endsWith('.sql'))
  for (const m of migrations) {
    if (!(await ctx.exec(`grep -q 'DOWN:' ${m}`)).exitCode === 0) {
      return { ok: false, reason: `${m} is missing a DOWN section` }
    }
  }
  return { ok: true }
})
```

```ts
// steps.ts — reuse the validators across steps
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

Two design notes worth being explicit about:

1. **Validators are orthogonal to `returns:`.** `returns:` parses and types the agent's structured output; `validate:` asserts facts about the step's side effects and output. They compose — a planner step often has both. A `check(fn)` can read `ctx.returns` to assert invariants on parsed output (see the plan example above).
2. **Validators run once per step, not per resume.** Validation is part of the step's success condition. If `validate:` passes, the result is persisted; on resume, the cached result is returned and the validator does not run again. This is intentional: the post-exit state at success time is the fact we care about. If you want a gate to re-run on every resume, put it outside `run()` or in `run.custom()`.

### 7. Escalation to human — the real primitives

The audit revealed that Claude Code and Codex have very different escalation models, and the gap between them shapes the orchestrator's API. The unified surface is `orch.requestHumanInput(reason, context)`, but the wiring differs:

**Claude Code (rich, layered, documented):**

1. **Primary — `PreToolUse` hook with `permissionDecision: "defer"`** (v2.1.89+, non-interactive only). The cleanest async escalation primitive in the ecosystem. A hook fires before a tool call, returns `{"hookSpecificOutput": {"permissionDecision": "defer", ...}}`, the run suspends gracefully, and the orchestrator resumes the step later with an allow/deny decision once the human has answered. Synchronous programmatic control, no MCP server required.
2. **Secondary — `--permission-prompt-tool <mcpTool>`** (CLI flag, confirmed in docs — not listed by `claude --help` but documented at https://code.claude.com/docs/en/cli-reference; the docs explicitly warn: *"`claude --help` does not list every flag, so a flag's absence from `--help` does not mean it is unavailable"*). Same effect as the SDK's `canUseTool` callback, just via an MCP tool in the CLI path.
3. **Side-channel (alerts only, not decisions) — `Notification` hook** with matchers `permission_prompt`, `idle_prompt`, `auth_success`, `elicitation_dialog`. Fires when a permission prompt is shown; lets the orchestrator pop a tmux pane or ring a bell, but does **not** itself return allow/deny.
4. **Also available — first-class hook events** `PermissionRequest`, `PermissionDenied`, `Elicitation`, `ElicitationResult` (out of 26 total hook events). Potentially more targeted than `Notification`-with-matcher; worth evaluating during implementation.

**Codex (sparse, with an active regression):**

Codex has **no `--permission-prompt-tool` equivalent**, and `codex_hooks` is behind a `under development` feature flag (default false). The only viable patterns:

1. **Blocking MCP tool in `~/.codex/config.toml`** — orchestrator exposes an MCP server with `orch__request_human_input` that blocks synchronously until a human replies. Must set a high `tool_timeout_sec` (e.g. 3600) or Codex will cancel the tool call. **Caveat (#16685, open at v0.118.0):** MCP elicitation is currently auto-cancelled in `codex exec` mode — so if our tool internally tries to elicit back to Codex, it fails. The workaround is to have the tool block on a file/socket instead.
2. **Short-run orchestration as escalation boundary** — structure long Codex flows as multiple short `codex exec` runs with orchestrator-driven decisions between them. Each run uses `--output-schema` to produce a structured final message like `{ status: "done" | "needs_human", question?: string }`. The orchestrator parses, handles the `needs_human` case with a tmux pane prompt, and spawns the next `codex exec resume <thread_id> "<human answer>"`. This is the most reliable Codex pattern, and it aligns well with Codex's one-shot nature.
3. **Important: there's no enforcement.** Codex can't be *forced* to call the human-input tool at the right moment. The only lever is prompt engineering (system prompt + examples). For critical escalation paths, prefer the short-run pattern over the MCP-tool pattern.

**The orchestrator API unifies both:** `run(STEP)` returns from either runner the same way. Users never touch the per-runner details unless they reach into `extraArgs`.

### 8. Dry-run / inspection before execution

Two modes:

- **Static pre-scan** — walk the workflow function AST (or execute it with every `run()` returning a stub Proxy that records calls) and print the linear skeleton. Lossy on branches (only goes down one path), but good enough for *"yep, that's what I want to run"*.
- **Dynamic post-plan rendering** — after the planning step completes, the plan is persisted; `orch status <run-id>` renders a tree with the known phases expanded. This is where the journaled plan pattern shines.

### 9. Resume from crash

Every `run(STEP)` call checks `state.json` for a cached result under the step's name. Present → return cached value without invoking the agent. Absent → run the step, persist, return. The workflow function re-executes top-to-bottom on resume; everything outside `run()` calls must be idempotent (documented constraint). This is exactly Inngest/Restate's memoization model — we reuse a battle-tested pattern.

### 10. What the operator actually sees — tmux pane mockup

The tmux layout isn't just a structural choice, it's the primary UI. Two panes on a dedicated socket (`tmux -L orchestrator`): a persistent **left status pane** that the orchestrator paints, and an **on-demand right agent pane** that either hosts an interactive agent or streams the live headless transcript. Here's what a run looks like mid-execution, during the `work-auth` step of the core example:

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
│  ○ review (security, performance, design)            │  ◇ Read(src/auth/session.ts)                            │
│                                                      │    → 118 lines                                           │
│  ─── totals ───                                      │                                                          │
│   elapsed   5m 41s                                   │  > Adding TokenService with rotation support.            │
│   cost      $1.42                                    │                                                          │
│   tokens    46,218 in / 81,176 out                   │  ◇ Edit(src/auth/token.ts)                              │
│                                                      │    + export class TokenService {                         │
│  ─── escalation ───                                  │    +   constructor(private readonly clock: Clock) {}     │
│   (none pending)                                     │    +   issue(userId: string): SignedToken { … }          │
│                                                      │                                                          │
│  ─── keys ───                                        │  ◇ Bash(pnpm test -- auth/token)                        │
│   [d] detach   [r] pop right pane                    │    PASS  src/auth/token.test.ts (3 tests, 412ms)         │
│   [s] status   [q] graceful stop                     │                                                          │
│   [!] force kill current step                        │  (streaming…)                                            │
└──────────────────────────────────────────────────────┴──────────────────────────────────────────────────────────┘
 [status]  run r-2026-04-09-a7f3 · step 3/9 work-auth · $1.42 · 5m41s · press ? for help
```

Glyphs on the left pane, reading top-to-bottom:

| Glyph | Meaning |
|---|---|
| `●` | step has started (running or finished) |
| `○` | step is pending (not yet reached in the workflow function) |
| `✓` | step completed, validator passed, result persisted to `state.json` |
| `⟳` | step currently running |
| `✗` | step failed (validator fail, agent error, max turns/budget) — pane stays open with transcript |
| `↯` | step suspended waiting for human input (escalation) |
| `↺` | step resumed from cache on this invocation (during `orch resume`) |
| `└ tool: …` | most recent tool call surfaced under the current step, for liveness |

Two things about the visualization that matter for the design:

1. **The left pane is redrawn from `state.json` + a small in-memory tail buffer, not from tmux scrollback.** This means `orch status <run-id>` from a *different* terminal can render the same view for a run that's not currently visible in any tmux session — useful for resume, for remote monitoring, and for the planned web companion.
2. **The right pane is a real TTY** (tmux pane), so Claude Code's and Codex's own TUIs render correctly without node-pty gymnastics. For headless steps, the right pane runs a small orchestrator process that tails the stream-json / ThreadEvent NDJSON and pretty-prints it into the same shape you see above. The key insight: we pretty-print headless streams to look like interactive transcripts, so the operator's mental model is the same for both.

An escalation moment looks like this — the left pane flips the `escalation` block and the right pane hosts a prompt:

```
┌─ orch: feature-build ── r-2026-04-09-a7f3 ──────────┬─ [ human input needed ] ── work-auth ──────────────────┐
│                                                      │                                                          │
│  ● brainstorm            ✓   3m 12s   $0.42   12k   │  work-auth is about to run:                              │
│  ● plan                  ✓   1m 47s   $0.88   28k   │                                                          │
│  ● work-auth             ↯   2m 18s   $0.34   14k   │    Bash(pnpm prisma migrate deploy)                      │
│    └ awaiting decision                               │                                                          │
│  ○ commit feat(auth)                                 │  Reason: tool call matched escalation rule              │
│  ○ work-api                                          │    `Bash(pnpm prisma migrate deploy)` in defer list      │
│                                                      │                                                          │
│  ─── escalation ───                                  │  Context (last 20 lines of transcript):                  │
│   work-auth  Bash(prisma migrate deploy)             │    > Applied schema change, running migration now…     │
│   waiting 0m 14s                                     │    > This will drop the deprecated sessions_v1 table.   │
│                                                      │                                                          │
│  ─── keys ───                                        │  [a] allow    [d] deny + feedback    [e] edit + allow  │
│   [d] detach   [r] pop right pane                    │  [x] abort run                                           │
└──────────────────────────────────────────────────────┴──────────────────────────────────────────────────────────┘
```

Three design consequences worth debating:

- **Do we keep the right pane visible at all times (even when empty between steps), or split on-demand and collapse?** The brainstorm currently says "on-demand right pane." But operator experience may be smoother if the pane is permanent and just shows "(idle — next step: commit feat(auth))" between steps. Leaning toward permanent-but-dimmed, with a `collapse right pane` key for screen-constrained users.
- **Scrollback is per-pane.** The right pane's agent output is not persisted in tmux beyond `history-limit 100000`. For ground truth, operators should read `.orchestrator/runs/<id>/steps/<step>.jsonl` — the pretty-printer is lossy by design (it drops most tool argument bodies).
- **We should mockup the status bar text explicitly**, because that one line is the most-read piece of UI and `tmux -F` format strings are load-bearing. Something like:
  ```
  #[bg=brightblack,fg=white] orch #[bg=default] #{@run_id} · #{@step_idx}/#{@step_count} #{@current_step} · #{@cost} · #{@elapsed}
  ```

## Prioritized feature list

### Must-have (v1 launch)

1. **`step.define()` + `workflow()` + `run()` primitives** — the core API above
2. **Claude Code runner** via subprocess (`claude --bare -p --output-format stream-json --verbose --settings <inline> --mcp-config <file> --permission-prompt-tool`)
3. **Codex runner** via subprocess (`codex exec --json --yolo --skip-git-repo-check -o <file>`)
4. **Typed structured returns** via Claude `--json-schema` and Codex `--output-schema`, parsed into Zod
5. **Tmux split layout** (dedicated socket, left status, on-demand right pane with `remain-on-exit on`)
6. **Per-step validators under `validate:`** — built-ins `fileProduced(glob)`, `gitDiffCreated()`, `gitCommitCreated()`; custom via inline `check(fn)` or reusable `defineValidator(name, fn)`; `validate:` accepts one or an array
7. **Escalation-to-human surface** — unified `orch.requestHumanInput()` API wired per-runner: Claude Code via `PreToolUse` hook with `permissionDecision: "defer"` (primary) or `--permission-prompt-tool` MCP tool (secondary); Codex via blocking MCP tool (`tool_timeout_sec=3600`) + short-run-and-structured-output fallback. `Notification` hook as a side-channel for alerts.
8. **Name-keyed run state persistence** + `orch resume <id>`
9. **`parallel()` helper** for typed concurrent execution with deterministic naming — supports both heterogeneous (different steps at once) and homogeneous (same step over N inputs) forms
10. **`defineRunner()` public API** — the same primitive `claude()` and `codex()` are built on; adding a new CLI agent is ~30 lines with no plugin machinery
11. **Explicit `commit()` step** primitive
12. **CLI**: `orch run`, `orch resume`, `orch runs`, `orch status`, `orch dry-run`
13. **Per-step structured logs** — each step's JSONL stream mirrored to `.orchestrator/runs/<id>/steps/<step>.jsonl`

### Should-have (v1.1)

- **Step presets** — `brainstormPreset()`, `planPreset()`, `workPreset()`, `reviewPreset()` with sensible defaults and inline overrides
- **`routeWith(llm, ...)` helper** for LLM-routed branches at decision points
- **`loop({ while, maxIterations })` helper** for the common retry-until pattern with status-pane iteration counter
- **`orch status` rich view** — tmux status bar shows current step, elapsed time, running token/cost totals
- **Journaled plan rendering** in dry-run after the first plan step completes
- **Squash helper** — `squash('feat: <message>', from: 'commit-sha')` for collapsing phase commits

### Could-have (v2+)

- **Worktree-per-run isolation** — `git worktree add .orchestrator/worktrees/<id>` so crashed runs don't corrupt the working tree (stolen from claude-squad)
- **DAG visualizer** — `orch graph <file.ts>` → Mermaid diagram (stolen from LangGraph.js)
- **Cost budget enforcement** — hard cap across the whole run via Claude `--max-budget-usd` + Codex token tracking
- **Third-party runner registry** — a way to publish runners as npm packages with discovery/versioning. v1 users just drop a runner file in `./runners/` and import it directly.
- **Web companion** — tail the run state file into a local dashboard (opt-in, not required)

## Architecture sketch

```
┌──────────────────────────────────────────────────────────────┐
│ orch CLI  (runs OUTSIDE tmux)                                │
│                                                              │
│   loads orchestration.ts via Bun                             │
│   creates tmux session on dedicated socket -L orchestrator   │
│   registers left status pane                                 │
│                                                              │
│   for each run(STEP) call:                                   │
│     1. check state.json for cached result under STEP.name    │
│        └─ hit: return cached value, skip execution           │
│     2. resolve step config (defaults + inline overrides)     │
│     3. prepare per-step .mcp.json + --settings (hooks)       │
│        └─ orch__request_human_input MCP tool registered      │
│     4. if interactive:                                       │
│        └─ split right tmux pane (initial-command form)       │
│        └─ poll #{pane_dead}, tail transcript jsonl           │
│     5. if headless:                                          │
│        └─ spawn runner as child (PTY to avoid macOS buffer)  │
│        └─ stream stream-json / ThreadEvent NDJSON            │
│        └─ update left-pane status + pane-border title        │
│     6. on exit:                                              │
│        └─ parse structured output (if `returns` declared)    │
│        └─ run `validate:` (one or array of validators)       │
│        └─ validator fail → pop pane, AskUserQuestion         │
│        └─ persist to state.json (step name → value)          │
│                                                              │
│   final: print summary, tmux kill-session (or keep-alive)    │
└──────────────────────────────────────────────────────────────┘
```

## What we steal from prior art

| Idea | Source | Why |
|---|---|---|
| Name-keyed step memoization for resume | Inngest / Restate | Simplest durable-execution model; no determinism burden |
| Plan-then-execute with journaled plan | Temporal convention / Dagster `DynamicOut` | Dynamic shape + inspectability without compile step |
| Typed structured outputs (`--json-schema`/`--output-schema`) | Claude Agent SDK / Codex | Killer feature nobody wired into a DSL yet |
| `parallel(items, fn)` + `parallel([...promises])` | Temporal / Trigger.dev `batchTriggerAndWait` | Plain JS + deterministic names; no `.map()` DSL; one primitive covers homogeneous fan-out and heterogeneous concurrent runs |
| Public `Runner` interface as v1 primitive (not plugin afterthought) | Original — most orchestrators bolt on plugins late | Wrapping new CLIs is a ~30-line file users write themselves; `claude()`/`codex()` use the exact same API |
| Reusable `step.define()` constants | Mastra `createStep` + Trigger.dev tasks | User's instinct; beats inline-only (VoltAgent) |
| Override at call site (`run(STEP, { ... })`) | User's instinct + Mastra's `getStepResult` spirit | Reads like a function call |
| tmux + git worktree isolation | claude-squad | The right isolation primitive |
| `tmux -L <named-socket>` | barkain/claude-code-workflow-orchestration | Multiplex without clobbering user's tmux |
| `DONE\|{path}` scratchpad handoff fallback | barkain | Simple, greppable when typed returns fail |
| `PreToolUse` hook with `permissionDecision: "defer"` | Claude Code v2.1.89+ | Cleanest documented async escalation primitive; obsoletes most need for a custom permission-prompt MCP server |
| `Notification` hook with `permission_prompt` matcher | Claude Code docs | Side-channel alert (not a decision path) — pops tmux pane, rings bell |
| Short-run + structured output for Codex escalation | Novel / synthesized | Works around Codex's missing escalation primitives |
| Mermaid graph render | LangGraph.js `getGraph().drawMermaidPng()` | Dry-run + status-pane visualization |
| Session lifecycle verbs (`run / resume / status`) | CCW (catlog22) | Clear mental model |
| `.commit()` compile step (split define from run) | Mastra | Enables dry-run and validation pass |

## What we explicitly avoid

| Anti-pattern | Source | Why |
|---|---|---|
| Hive-mind with consensus protocols | claude-flow / ruflo | Premature distribution; undebuggable |
| Hidden SQLite / vector memory | claude-flow | Debugging impossible |
| 300+ MCP tools / 20+ agents out of the box | claude-flow, CCW | Surface area kills adoption |
| Natural-language-only orchestration | agent teams, CCW, barkain | Not versionable, not diffable |
| Auto-generated configs user can't edit | agent teams | "Your changes are overwritten" is hostile |
| Web UI as default observability | claude-workflow | Higher friction than tmux |
| Untyped shared state / KV blackboard | Inngest AgentKit | Silent breakage as pipelines grow |
| Inline-only step definitions | VoltAgent | Forces copy-paste for reuse |
| Branching as a DSL primitive | Dagster, Airflow, Mastra `.branch([[...]])` | Self-inflicted pain; plain `if` is strictly nicer |
| Determinism requirement on whole workflow function | Temporal | Too heavy for CLI-agent workflows full of timestamps/IDs |
| Imperative `await run(X); await run(Y)` without memoization | user's initial sketch | Breaks resume unless every line is idempotent — fragile contract |

## Non-obvious risks (design around these)

1. **Config-as-code Turing tarpit.** Once users discover they can write arbitrary TS in `orchestration.ts`, the file grows into a 400-line program. nx learned this the hard way. **Mitigation:** publicly document that if your workflow is >100 lines, you probably want to split steps into helpers or use presets. Don't restrict the language, just nudge.
2. **macOS non-TTY stdout buffering.** Claude/Codex CLIs buffer 4KB chunks when stdout isn't a TTY — breaks real-time streaming for headless steps. **Mitigation:** allocate a PTY for every headless spawn (`node-pty`), or run every step inside a tmux pane (which is a TTY).
3. **tmux `pane-died` hook is best-effort.** Issue #2483 documents inconsistent firing. **Mitigation:** always back hooks with `#{pane_dead}` polling every 300ms.
4. **Claude Code slash commands don't work in `-p` mode.** Can't pass `/workflows:plan` as a prompt. **Mitigation:** use `--append-system-prompt-file <skill-body>` to inline the skill body, or use interactive mode + `--input-format stream-json` for multi-turn feeding. Note that `.claude/skills/` auto-loading from `--add-dir` targets is not explicitly documented (docs say "most `.claude/` configuration is not discovered from added dirs") — verify empirically before relying on it.
5. **Codex escalation is genuinely thin.** Production-stage `codex_hooks` doesn't exist (feature flag `under development`). There's no `--permission-prompt-tool` equivalent. `request_user_input` is plan-mode only. MCP elicitation is auto-cancelled in `codex exec` mode (open regression #16685 at v0.118.0). **Mitigation:** for Codex we ship two escalation patterns — (a) a blocking MCP tool with `tool_timeout_sec=3600` that waits on a file/socket (not elicitation) for the human answer, and (b) the "short-run + structured output" pattern where each `codex exec` emits a `{status, question?}` schema and the orchestrator handles escalation between runs. For critical decision points, prefer (b) — it doesn't depend on the model remembering to call a tool.
6. **Dry-run can't fully trace branches.** A stub-replay only goes down one path through `if`. **Mitigation:** document the limitation; dry-run is best-effort pre-execution preview, not a proof. The journaled plan pattern gives real visibility after the first planning step.
7. **Resume assumes idempotent code between `run()` calls.** If the user does `await fs.writeFile(...)` between two `run()` calls, the second resume re-runs it. **Mitigation:** document this contract prominently; offer `run.custom(name, fn)` wrapper so side effects have a name and get memoized too.

8. **Injecting hooks via `--settings` inline JSON is an inference, not a documented workflow.** `--settings` accepts inline JSON and the settings schema includes a `hooks` key, so in principle it works — but the docs don't spell out per-invocation hooks as a supported path. **Mitigation:** prototype it early and fall back to writing a temporary `.claude/settings.local.json` in the working dir if inline fails. Keep a canary test in CI.

## Open questions

1. **Project name.** "claude-orchestrator" is misleading (Codex is a first-class runner). Candidates: `orch`, `conduit`, `forge`, `chain`, `dispatch`, `teammate`. Name matters more for OSS adoption than we'd like.
2. **Bun vs Node default.** We picked Bun for speed and native TS execution. If we find that node-pty is load-bearing for headless steps (because agents aren't always spawned inside tmux panes), we may flip to Node+tsx.
3. **Claude Agent SDK vs CLI subprocess.** Research recommends subprocess for OS isolation, language-agnosticism, and per-session hook injection. SDK gives tighter in-process hook callbacks. Decision: subprocess for v1, revisit if escalation round-trips feel slow.
4. **MCP server lifecycle.** Per-step stdio server (spawned by orch, wired via `--mcp-config`) or long-running singleton for the whole run? Per-step stdio is simpler and more isolated. Likely answer: per-step, with a shared socket for the human-input escalation path.
5. **Skill scoping per step.** Where do per-step skills live? Likely `.orchestrator/runs/<id>/skills/<step>/SKILL.md` + `--add-dir` (since `.claude/skills/` is auto-loaded from added dirs).
6. **Codex interactive steps.** Codex lacks any equivalent to `--permission-prompt-tool` and has no programmatic escalation path from interactive TUI. Constraint: **interactive steps are Claude-only in v1; Codex is headless-only** (either one-shot `codex exec` or orchestrator-mediated multi-run chains via `codex exec resume <thread_id>`). Interactive exit is `/quit` or `/exit` (the slash is required; bare `quit`/`exit` doesn't work — issue #13691).
7. **Worktree per run.** Clean isolation but complicates resume (state files live where?). Probably v2, not v1.
8. **"Compile step" the user mentioned.** Research confirms this isn't needed — name-keyed memoization solves resumability without a compile phase. But it remains an interesting angle for generating Mermaid DAGs from workflow sources (purely for visualization, not execution). Could-have.
9. **How much of the `@anthropic-ai/claude-agent-sdk` do we adopt?** Using the SDK in-process for short classification/routing calls (the LLM-router escape hatch) might be cleaner than another subprocess. Hybrid: subprocess for long agent runs, SDK for orchestrator-internal LLM calls.
10. **Open-source positioning.** Do we target the "compound engineering" community directly, or pitch broader ("TypeScript workflow for any coding-agent CLI")? The name + README voice depends on this.
11. **Claude Code escalation — which primitive do we lead with?** The audit surfaced three viable paths: (a) `PreToolUse` hook with `permissionDecision: "defer"` (cleanest, v2.1.89+, non-interactive only), (b) `--permission-prompt-tool` routing to our MCP server, (c) first-class `PermissionRequest` / `Elicitation` hook events. Plausible default: lead with (a), expose (b) as an escape hatch for users who want to run their own MCP server. Evaluate (c) when we implement.
12. **Codex minimum version pinning.** `--output-schema` exists in `codex-cli >= 0.118.0` but isn't in the public `developers.openai.com/codex` config reference — it's only in the `codex-rs/exec/src/cli.rs` source. We should pin a minimum version in our docs and add a preflight check.

## Appendix: verified CLI recipes (audited 2026-04-08)

**Claude Code headless — canonical orchestrator invocation:**
```bash
claude --bare -p "<prompt>" \
  --session-id <pre-generated-uuid> \
  --output-format stream-json --verbose \
  --include-hook-events \
  --settings ./per-step-settings.json \
  --mcp-config ./per-step-mcp.json --strict-mcp-config \
  --permission-prompt-tool mcp__orch__request_human_input \
  --allowedTools "Bash,Read,Edit,Write" \
  --max-turns 20 --max-budget-usd 5.00 \
  --output-format json --json-schema '<inline-schema>'
```
- End-of-run signal: final `{"type":"result", "subtype":"success|error_max_turns|error_during_execution|error_max_budget_usd|error_max_structured_output_retries", ...}` line. (We cite `subtype`, not `terminal_reason` — that field does not exist.)
- Live transcript: `~/.claude/projects/<cwd-encoded>/<uuid>.jsonl` where cwd-encoded replaces `/` with `-`.
- **Alternative escalation primitive** (often cleaner than `--permission-prompt-tool`): inline a `PreToolUse` hook in `--settings` that returns `{"hookSpecificOutput": {"permissionDecision": "defer"}}` for the tool calls you want to route through the human. v2.1.89+, non-interactive mode only.
- **MCP config file locations** (note: not `~/.claude/.mcp.json` — that's not the documented user/local path):
  - Project scope (version-controlled): `.mcp.json` in repo root
  - User/local scope: `~/.claude.json`
  - Managed (macOS): `/Library/Application Support/ClaudeCode/managed-mcp.json`
- `claude --help` does not list every flag — see https://code.claude.com/docs/en/cli-reference for the full list. Flags like `--permission-prompt-tool`, `--json-schema`, and `--max-turns` are real but not in `--help` output.

**Codex headless — canonical orchestrator invocation:**
```bash
codex exec \
  --skip-git-repo-check \
  --sandbox workspace-write \
  -c approval_policy='"never"' \
  -C /workspace \
  -m gpt-5.4 \
  --add-dir /workspace/shared \
  --json \
  -o /tmp/codex-final.txt \
  --output-schema ./schema.json \
  "<prompt>" \
  2>/tmp/codex.log | tee /tmp/codex-stream.jsonl

SESSION_ID=$(head -1 /tmp/codex-stream.jsonl | jq -r 'select(.type=="thread.started").thread_id')
```
- **Do NOT use `--yolo`** unless the run is already inside an external sandbox (container/VM). The flag's own help text calls it "EXTREMELY DANGEROUS". `--full-auto` is also NOT headless-safe — it uses `approval_policy = on-request` which would prompt.
- **There is no `-a` / `--ask-for-approval` flag on `codex exec`** (exists on top-level `codex` and `codex resume` only). Set approval policy via `-c approval_policy='"never"'` or a profile.
- **`--output-schema` exists only on `codex exec`**, not on top-level `codex` or `codex resume`. Available in `codex-cli >= 0.118.0`.
- End-of-run signal: last JSONL line is `{"type":"turn.completed", "usage":{...}}` on success, `{"type":"turn.failed", ...}` on failure. Process exit code `0` on success.
- Rollout transcript: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ISO-timestamp>-<uuid>.jsonl`. Flushed after every update; safe to tail live. The `<uuid>` in the filename is a UUIDv7 and equals the `thread_id` from the first `thread.started` event — they're the same identifier.
- **`codex_hooks` is a feature flag** (stage `under development`, default `false`). Not comparable to Claude Code's production hook system. Don't rely on Codex hooks in v1.

**Escalation MCP server — Codex config (`~/.codex/config.toml`):**
```toml
[mcp_servers.orch]
command = "node"
args = ["/path/to/orch-mcp/server.js"]
startup_timeout_sec = 10
# Long timeout because the human-input tool blocks on a real human
tool_timeout_sec = 3600
enabled_tools = ["request_human_input"]
```
Caveat: MCP elicitation is currently auto-cancelled in `codex exec` mode (open regression #16685 at v0.118.0). Our `request_human_input` tool must block on a file/socket instead of calling back into Codex via elicitation.

**tmux setup — dedicated socket, left status + right agent:**
```bash
tmux -L orchestrator new-session -d -s run -x 220 -y 55 -n main
tmux -L orchestrator set -t run pane-border-status top
tmux -L orchestrator set -g -t run history-limit 100000
# Left pane is the initial pane (%0). Right pane opens on demand:
tmux -L orchestrator split-window -h -t run:main.0 -P -F '#{pane_id}' \
  'claude --bare -p "..." ...'
tmux -L orchestrator set-option -p -t <pane_id> remain-on-exit on
# Poll #{pane_dead} every 300ms; on exit read #{pane_dead_status}, capture-pane -S -, then kill-pane.
```

**tmux setup — dedicated socket, left status + right agent:**
```bash
tmux -L orchestrator new-session -d -s run -x 220 -y 55 -n main
tmux -L orchestrator set -t run pane-border-status top
tmux -L orchestrator set -g -t run history-limit 100000
# Left pane is the initial pane (%0). Right pane opens on demand:
tmux -L orchestrator split-window -h -t run:main.0 -P -F '#{pane_id}' \
  'claude --bare -p "..." ...'
tmux -L orchestrator set-option -p -t <pane_id> remain-on-exit on
# Poll #{pane_dead} every 300ms; on exit read #{pane_dead_status}, capture-pane -S -, then kill-pane.
```

---

*First brainstorm document. Next step: `/workflows:plan` to convert this into an architectural plan with file structure, data model, and phase breakdown.*
