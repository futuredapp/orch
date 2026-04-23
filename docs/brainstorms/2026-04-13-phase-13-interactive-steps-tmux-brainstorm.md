---
date: 2026-04-13
status: active
topic: Phase 13 — Interactive steps + tmux observability
---

# Phase 13 — Interactive Steps + Tmux Observability Brainstorm

## What We're Building

A step-level interactivity primitive and a tmux-based observability layer. The core insight: some workflow steps need the human in the loop (brainstorm, review), while others run headlessly (plan, work). The orchestrator must handle both, with or without tmux.

**Three sub-phases, each landing independently:**

| Sub-phase | Scope | Tmux required? |
|---|---|---|
| **13a** — Interactive step mode | `mode` flag on steps, foreground takeover, process exit completion | No |
| **13b** — Tmux pane management | TmuxService port, two-pane layout, `--observe`, auto-detect | Yes |
| **13c** — Status pane + polish | Left-pane status renderer, glyph rendering, elapsed time | Yes |

## Why This Approach

### Interactive vs. autonomous is a step-level concern

The user's primary workflow — brainstorm, plan, work, review — has a natural split: brainstorm is deeply interactive (human and agent converse to reach shared understanding), while plan/work/review are mostly autonomous. Making interactivity a step-level property (with run-time override) means the same workflow definition works for both hands-on development and CI.

### Three orthogonal layers, not one monolith

| Layer | What | Scope |
|---|---|---|
| **Step mode** | `interactive` / `autonomous` | Per-step definition, overridable at `run()` |
| **Observe** | Stream agent activity to a visible pane | Global runtime flag (`--observe`) |
| **Gate** | Pause for human approval | Deferred to Phase 14+ (shares machinery with escalation) |

Separating these avoids a combinatorial explosion. A step is either interactive or autonomous — that's about _who drives the conversation_. Observe is about _visibility_ (can I watch what the autonomous agent is doing?). Gate is about _approval checkpoints_ — deferred because it shares machinery with the escalation hooks in the original Phase 14.

### Foreground takeover is the non-tmux default

Without tmux, interactive steps simply hand the terminal to Claude. `Bun.spawn(['claude', ...], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })` gives the user a normal Claude session. `await proc.exited` resumes the orchestrator. No dependencies, works everywhere.

### Tmux on a dedicated socket avoids nesting issues

All tmux commands target `-L orch` (a separate server socket). This means:
- No clobbering of the user's personal tmux sessions.
- No nested-tmux complications — `-L orch` is a different server entirely.
- The `$TMUX` env var tells us if we're already inside a tmux client (for auto-detection).

## Key Decisions

### 1. Step mode DSL: default + override

Steps declare a default mode in `step.define()`. The workflow author can override at the `run()` call site.

```typescript
const BRAINSTORM = step.define('brainstorm', {
  runner: claude(),
  mode: 'interactive',  // default mode
  prompt: 'Let\'s brainstorm the auth redesign...',
})

const PLAN = step.define('plan', {
  runner: claude(),
  // mode defaults to 'autonomous'
  prompt: 'Create an implementation plan based on: {{brainstorm}}',
})

workflow('dev', async (run) => {
  const b = await run(BRAINSTORM)                        // interactive (default)
  const p = await run(PLAN)                              // autonomous (default)
  const b2 = await run(BRAINSTORM, { mode: 'autonomous' }) // override for CI
})
```

**Type impact:** `StepMode = 'interactive' | 'autonomous'` added to `AgentStepConfig`. The `mode` field is optional, defaulting to `'autonomous'`.

### 2. Completion signal: process exit + optional MCP

- **Without schema:** Process exit = step done. `exitCode` captured in the result.
- **With schema:** An MCP `step_complete` tool is injected via `--mcp-config`. Claude can call it to return structured data. If the user `/exit`s without calling it, the step completes with no structured output (logged as a warning).

For Phase 13a, only process exit is implemented. MCP signal is deferred to 13c or later (it needs the MCP injection infrastructure).

### 3. Interactive step return value: `InteractiveResult`

Interactive steps always return:

```typescript
interface InteractiveResult {
  exitCode: number
  durationMs: number
  sessionId: string  // Claude's --session-id, enables --continue later
}
```

This means downstream steps can reference the session (e.g., `--continue` to resume the conversation) and check if the session exited cleanly.

**Type impact:** `Step<T>` where `T` is inferred from `schema` for autonomous steps, but `InteractiveResult` for interactive steps (or `InteractiveResult & T` when MCP signal + schema are both present).

### 4. Prompt as seed message

In interactive mode, the `prompt` field becomes the opening message in the Claude session:

```
claude "Let's brainstorm the auth redesign..."
```

This seeds the conversation with context from previous steps while letting the user take over. In autonomous mode, the same `prompt` field is sent via `-p` (headless).

The runner's `buildCommand` switches behavior based on `mode`:
- `autonomous`: `claude --bare -p <prompt> --output-format stream-json ...`
- `interactive`: `claude <prompt> --session-id <uuid>` (no `--bare`, no `-p`, no `--output-format`)

### 5. Runtime environment auto-detection with flag override

| Environment | Default behavior | Override |
|---|---|---|
| Inside tmux (`$TMUX` set) | Interactive steps open in right pane | `--single-pane` → foreground takeover |
| Not in tmux | Foreground takeover | `--tmux` → create session + attach |
| `--observe` flag | Implies tmux (needs a pane for activity stream) | — |

Detection logic in the CLI layer, not in the runner or workflow core.

### 6. Observe mode: raw agent stdout

When `--observe` is active and an autonomous step runs, the agent's stdout is piped to the right tmux pane. The user sees raw tool calls, file edits, and reasoning in real time — no custom rendering, just the agent's own output stream.

For interactive steps in tmux, the right pane already shows the full Claude TUI (since that's where the interactive session runs).

### 7. Session ID threading

The orchestrator generates a UUID for each interactive step and passes it via `--session-id`. This:
- Makes sessions discoverable for resume (`--continue` in a later run).
- Enables the `sessionId` field in `InteractiveResult`.
- Gets stored in `StepEntry.artifacts` for traceability.

## Detailed Sub-phase Breakdown

### Phase 13a — Interactive Step Mode

**Goal:** Users can mark steps as interactive. Works without tmux.

**Deliverables:**
- `StepMode` type (`'interactive' | 'autonomous'`) in `src/core/types.ts`.
- `mode` field on `AgentStepConfig` (optional, defaults to `'autonomous'`).
- `mode` override in `run()` options.
- `InteractiveResult` type in `src/core/types.ts`.
- `ClaudeRunner.buildCommand` branches on `mode`: headless vs. interactive CLI flags.
- Executor handles interactive mode: foreground spawn (`stdin: 'inherit'`), no NDJSON parsing, `InteractiveResult` construction.
- `RunnerContext.mode` field added.

**Tests:**
- Unit — `buildCommand` produces correct argv for interactive vs. autonomous.
- Unit — `StepMode` defaults, override precedence.
- Unit — `InteractiveResult` shape.
- Integration (mocked) — `FakeProcessService` simulates interactive exit; executor returns `InteractiveResult`.
- Integration (real, gated) — real `claude` in interactive mode with auto-exit (if feasible).

**What's NOT in 13a:** Tmux, observe, MCP signal, status pane.

### Phase 13b — Tmux Pane Management

**Goal:** Two-pane tmux layout with auto-detection.

**Deliverables:**
- `src/services/tmux/tmux-service.ts` — `TmuxService` interface: `createSession`, `splitPane`, `sendKeys`, `waitForExit`, `killPane`, `capturePane`, `isInsideTmux`, `pipePane`.
- `src/services/tmux/real-tmux-service.ts` — real adapter using `ProcessService` to run `tmux -L orch` commands.
- `src/services/tmux/fake-tmux-service.ts` — scriptable fake with command recording.
- `src/services/tmux/index.ts` — barrel.
- `--tmux`, `--single-pane`, `--observe` CLI flags.
- Environment auto-detection logic (`$TMUX`).
- Interactive steps in tmux: run Claude in the right pane, `wait-for` + `pane-died` hook for completion.
- Observe mode: pipe autonomous step's stdout to right pane via `pipe-pane` or direct pane spawn.
- `remain-on-exit on` for post-failure inspection.
- Pane lifecycle: create on step start, detect exit via `wait-for`, clean up (or preserve on error).

**Tests:**
- Unit — `TmuxService` method contracts.
- Integration — `FakeTmuxService` records commands; verify lifecycle sequence.
- Integration (gated by `tmux -V`) — real tmux on `-L orch-test` socket: create session, split, send command, wait for exit, clean up.

### Phase 13c — Status Pane + Observe Polish

**Goal:** Left-pane status renderer showing workflow progress.

**Deliverables:**
- `src/observability/status-pane.ts` — pure function: `(RunState, tailBuffer) → string[]`. No I/O.
- `src/observability/index.ts` — barrel.
- Glyph rendering: `●` running, `○` pending, `✓` completed, `✗` failed, `↺` cached, `⟳` interactive.
- Elapsed time per step, total workflow time.
- Live "current action" line under running step (from InfoEvent tail buffer).
- Status pane update loop: re-render on state change + timer tick.
- Reuse `glyphs()` from `src/cli/format.ts` or unify the glyph set.

**Tests:**
- Unit — snapshot tests for every glyph and state combination.
- Unit — pure render function with various `RunState` shapes.
- Integration — status pane + `FakeTmuxService` verifies pane content updates.

## What It Looks Like — State Examples

### Example workflow

```typescript
const BRAINSTORM = step.define('brainstorm', {
  runner: claude(), mode: 'interactive',
  prompt: 'Let\'s brainstorm the auth redesign...',
})
const PLAN = step.define('plan', { runner: claude(), prompt: 'Create a plan...' })
const WORK = step.define('work', { runner: claude(), prompt: 'Implement the plan...' })
const REVIEW = step.define('review', { runner: claude(), prompt: 'Review the diff...' })
const SHIP = commit('Ship auth redesign')

workflow('dev', async (run) => {
  const b = await run(BRAINSTORM)
  const p = await run(PLAN)
  const w = await run(WORK)
  const r = await run(REVIEW)
  await run(SHIP)
})
```

---

### State 1: Non-tmux, interactive step running (foreground takeover)

```
$ orch run dev

  orch · dev · r-2026-04-13-a1b2
  ● brainstorm  [interactive — launching Claude session...]

─── terminal hands over to Claude ──────────────────────

╭──────────────────────────────────────────────────────╮
│  Claude Code                                         │
│                                                      │
│  > Let's brainstorm the auth redesign...             │
│                                                      │
│  I'd love to help brainstorm the auth redesign.      │
│  Let me ask a few questions first:                   │
│                                                      │
│  1. What's the current auth mechanism?               │
│  2. What's driving the redesign?                     │
│                                                      │
│  User: We're using JWT but need to move to sessions  │
│  because of compliance requirements...               │
│                                                      │
│  (normal interactive Claude session)                 │
│  (user types /exit when done)                        │
╰──────────────────────────────────────────────────────╯

─── Claude exits, terminal returns to orch ─────────────

  orch · dev · r-2026-04-13-a1b2
  ✓ brainstorm  12m 34s  (session: abc-123)
  ● plan        [running...]
```

### State 2: Tmux, interactive step in right pane

```
$ orch run --tmux dev

┌─── left pane (status) ──────┬─── right pane (interactive) ──────────┐
│                              │                                       │
│  orch · dev                  │  Claude Code                          │
│  r-2026-04-13-a1b2           │                                       │
│                              │  > Let's brainstorm the auth          │
│  ⟳ brainstorm   3m 12s      │    redesign...                        │
│  ○ plan                      │                                       │
│  ○ work                      │  I'd love to help! Let me ask:        │
│  ○ review                    │  1. What's the current auth?          │
│  ○ ship                      │  2. What's driving this?              │
│                              │                                       │
│                              │  User: JWT → sessions, compliance     │
│                              │  Claude: Got it. So the key...        │
│                              │                                       │
│                              │  (full Claude TUI, user interacts     │
│                              │   normally in this pane)              │
│                              │                                       │
└──────────────────────────────┴───────────────────────────────────────┘
```

### State 3: Tmux, autonomous step running + --observe

```
$ orch run --tmux --observe dev

┌─── left pane (status) ──────┬─── right pane (observe) ──────────────┐
│                              │                                       │
│  orch · dev                  │  [work] autonomous · live output      │
│  r-2026-04-13-a1b2           │                                       │
│                              │  [tool] Read src/auth/session.ts      │
│  ✓ brainstorm   12m 34s     │  [tool] Read src/auth/jwt.ts          │
│  ✓ plan          2m 01s     │  [thinking] I need to replace the     │
│  ● work          4m 33s     │    JWT middleware with a session-      │
│    └ Edit src/auth/...       │    based approach...                   │
│  ○ review                    │  [tool] Edit src/auth/session.ts      │
│  ○ ship                      │    +  export class SessionService {   │
│                              │    +    async create(userId: string)   │
│                              │    +    async validate(token: string)  │
│                              │  [tool] Write tests/unit/auth/...     │
│                              │  [tool] Bash: bun test                │
│                              │    ✓ 14 passed (2.1s)                 │
│                              │                                       │
└──────────────────────────────┴───────────────────────────────────────┘
```

### State 4: Non-tmux, autonomous steps (no visual — just progress line)

```
$ orch run dev

  orch · dev · r-2026-04-13-a1b2
  ✓ brainstorm   12m 34s  (session: abc-123)
  ✓ plan          2m 01s
  ● work          4m 33s  ← spinner updates in-place
  ○ review
  ○ ship
```

### State 5: Resume after crash (interactive step cached, plan re-runs)

```
$ orch resume r-2026-04-13-a1b2

  orch · dev · r-2026-04-13-a1b2 (resumed)
  ✓ brainstorm   12m 34s  ↺ cached (session: abc-123)
  ✗ plan         CRASHED  → re-running from scratch
  ● plan          0m 12s  [running...]
  ○ work
  ○ review
  ○ ship

  Note: brainstorm was interactive but already completed.
  Session abc-123 available via: claude --continue abc-123
```

### State 6: CI / headless (all autonomous, no tmux)

```
# In CI pipeline — all interactive defaults overridden
$ orch run dev

  orch · dev · r-2026-04-13-c1d2
  ● brainstorm   [autonomous]  0m 45s   ← mode override or CI auto-detect
  ○ plan
  ○ work
  ○ review
  ○ ship
```

### State 7: Tmux, step failed — right pane preserved for inspection

```
┌─── left pane (status) ──────┬─── right pane (preserved) ────────────┐
│                              │                                       │
│  orch · dev                  │  [work] FAILED · remain-on-exit       │
│  r-2026-04-13-a1b2           │                                       │
│                              │  [tool] Bash: bun test                │
│  ✓ brainstorm   12m 34s     │    ✗ 3 failed, 11 passed              │
│  ✓ plan          2m 01s     │                                       │
│  ✗ work          6m 12s     │  FAIL tests/unit/auth/session.test.ts │
│    └ bun test: 3 failed      │    ✗ validates token expiry           │
│  ○ review                    │    ✗ rejects tampered tokens          │
│  ○ ship                      │    ✗ handles clock skew               │
│                              │                                       │
│  Run crashed. Resume:        │  (pane stays open for inspection —    │
│  orch resume r-2026-04-13-.. │   remain-on-exit on)                  │
│                              │                                       │
└──────────────────────────────┴───────────────────────────────────────┘
```

---

## Use Cases This Enables

1. **Brainstorm-driven development** — Brainstorm is interactive (user and Claude co-create the design), plan/work/review are autonomous. User runs `orch run dev`, converses during brainstorm, then walks away while the rest executes.

2. **Selective deep-dive** — A 6-step workflow where only step 3 (database migration) is interactive. User co-authors the migration, approves the SQL, then auto-runs the rest.

3. **Debug/observe mode** — User adds `--observe` to watch a long-running autonomous work step in real time. Catches wrong turns early without having to wait for the step to complete and fail.

4. **CI/headless override** — Same workflow runs fully autonomous in CI: `orch run dev` with all modes defaulting to autonomous. No tmux, no interaction, pure headless.

5. **Review with intervention** — Review step surfaces issues interactively. User discusses findings with Claude, directs specific fixes, then the next step (commit) runs autonomously.

6. **Session continuity** — User exits a brainstorm mid-conversation. Later, `--continue` resumes the Claude session from where they left off (via `sessionId` in `InteractiveResult`).

## Open Questions

_All resolved during brainstorm — see Resolved Questions._

## Resolved Questions

- **Gate primitive?** → Deferred to Phase 14+ (shares "pause for human" machinery with escalation hooks).
- **MCP step_complete tool?** → Deferred to Phase 13c or later. Phase 13a uses process exit only.
- **Observe rendering?** → Raw agent stdout piped to the pane, not a custom-formatted feed.
- **Codex interactive mode?** → Codex doesn't have a TUI. Interactive mode for Codex is not supported — error at step definition time. Runner declares `supports.interactive: true/false`.
- **Multiple interactive steps back-to-back?** → Each gets its own foreground session (non-tmux) or right pane (tmux). Sequential, not parallel.
- **Observe mode wiring?** → Raw stdout tee'd to tmux pane. Agent process stdout goes to both the NDJSON parser (orchestrator) and the pane (human). No changes to `runRunner` needed — use `tmux pipe-pane` or spawn the agent inside the tmux pane directly.
- **Interactive step memoization?** → Yes. Completed interactive steps are cached like any other step. Resume skips them. `InteractiveResult` (with `sessionId`) is stored in `state.json`. User can `--continue` the Claude session separately if needed.
- **Parallel interactive steps?** → Always an error. `parallel()` with interactive steps throws. Interactive steps are inherently sequential (one human, one conversation at a time).
- **Unsupported runner + interactive mode?** → Error at step definition time. Runner declares `supports.interactive` capability. `step.define()` throws if `mode: 'interactive'` is set but the runner doesn't support it.
