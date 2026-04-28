---
title: "Phase 13 — Interactive Steps + Tmux Observability"
type: feat
status: active
date: 2026-04-13
deepened: 2026-04-13
---

# Phase 13 — Interactive Steps + Tmux Observability

## Enhancement Summary

**Deepened on:** 2026-04-13 | **Research agents:** 13

### Key Improvements

1. **Compile-time safety:** `step.define` overloads prevent `returns:` + `mode: 'interactive'` at the type level. `RunFn` overloads make mode override return types honest.
2. **Security hardening:** Branded `SocketName` type, `--` flag terminator before prompt, SIGINT handler during foreground, ~~env allowlist for tmux commands~~ (env policy is now passthrough — see [2026-04-27 env passthrough plan](2026-04-27-feat-env-passthrough-plan.md)), ANSI escape stripping.
3. **Agent-native hooks:** `onInteractive`, `onStepEvent`, `onEvent` callbacks on `WorkflowDeps` decouple interactive mode from TTY and observability from tmux.
4. **Performance:** Concatenate sendKeys into single call (6.5x faster). Move remain-on-exit/pane-died hook to session init. Left pane runs `cat` not a shell.
5. **Simplification:** Reduce TmuxService from 16 to 11 methods. Remove `--single-pane`. Remove observe formatter (use raw stdout). Inline pane lifecycle.
6. **Critical gap:** Brainstorm-to-plan data handoff broken — `InteractiveResult` has no conversation content. Needs `transcriptPath` or `--continue` chaining.
7. **Parallel guard:** Naive depth counter won't work — needs `AsyncLocalStorage` or workflow-scoped `parallel` wrapper.
8. **Tmux findings:** Use global hooks only (`-g`), per-pane hooks have bugs. `wait-for` has no timeout — implement own. `display-message` returns exit 0 with empty output for invalid panes — must validate. Bump minimum to tmux >= 3.2 for `remain-on-exit failed`.

---

## Overview

Step-level interactivity and tmux-based observability. Three independently-landing sub-phases:

| Sub-phase | Scope | Tmux? |
|---|---|---|
| **13a** | Interactive step mode (mode flag, foreground takeover, `InteractiveResult`) | No |
| **13b** | Tmux pane management (`TmuxService`, two-pane layout, `--observe`) | Yes |
| **13c** | Status pane + observe polish (renderer, glyphs, elapsed time) | Yes |

## Problem Statement

The orchestrator runs all steps headlessly. Users cannot converse with an agent mid-workflow or watch autonomous work in real time. This blocks brainstorm-driven development.

**Critical gap — brainstorm-to-plan data handoff:** When `prompt: '{{brainstorm}}'` is used downstream, it resolves to `InteractiveResult { exitCode, durationMs, sessionId }`, not conversation content. Options: (a) `transcriptPath` field in `InteractiveResult`, (b) `--continue` chaining for downstream steps, (c) MCP `step_complete` tool (deferred). **Decide before implementation.**

## Architecture Decisions

### AD-1: ProcessService gains `spawnForeground()`

New method with `ForegroundHandle` return type. Extract `ProcessHandle` base type shared by `SpawnHandle` and `ForegroundHandle`:

```typescript
interface ProcessHandle { wait(): Promise<{ readonly exitCode: number }>; kill(signal?: NodeJS.Signals): void }
interface SpawnHandle extends ProcessHandle { readonly stdout: AsyncIterable<string>; readonly stderr: AsyncIterable<string> }
type ForegroundHandle = ProcessHandle
```

**Security:** SIGINT must be trapped during foreground — both parent and child are in the same process group. Exit code 130 = SIGINT (Ctrl-C) — consider treating as cancellation, not crash. `proc.exited` resolves to `number`, never rejects. Signal deaths produce 128+N.

### AD-2: Interactive steps return `InteractiveResult`

`step.define()` with `mode: 'interactive'` produces `Step<InteractiveResult>`. Enforce at compile time via `step.define` overloads (interactive overload has no `returns` field). Keep runtime guard as belt-and-suspenders.

**Zod schema:** Use `satisfies z.ZodType<InteractiveResult>` to bind schema to interface. Add `.int()`, `.nonneg()`, `.uuid()` refinements. Persist `mode?: StepMode` in `StepEntry` for agent observability.

### AD-3: Non-zero interactive exit throws StepError

Consistent with autonomous steps. **Verify:** Claude `/exit` returns exit code 0. If non-zero, every interactive step would appear to crash.

### AD-4: Parallel guard via `AsyncLocalStorage`

The naive depth counter on `RunFn` won't work — `parallel([run(A), run(B)])` executes `run()` calls immediately. Use `AsyncLocalStorage`:

```typescript
// src/core/execution-context.ts
export const executionContext = new AsyncLocalStorage<{ parallelDepth: number }>()
// parallel() wraps branches: executionContext.run({ parallelDepth: ctx.parallelDepth + 1 }, ...)
// runStepOnce checks: ctx.parallelDepth > 0 && interactive → throw InteractiveParallelError
```

### AD-5: Runner capability validation is lazy

At `run()` time, not `step.define()` time. Matches existing `checkSchemaCapability` pattern. **Action:** Update brainstorm doc to match (currently contradicts).

### AD-6: Orchestrator runs outside tmux

Manages panes remotely via `tmux -L orch`. After creating session, calls `attachSession()`. **Add `selectPane`** to focus right pane for interactive steps.

### AD-7: TmuxService centralized

All tmux in `src/services/tmux/`. **Move `isInsideTmux` to `src/cli/detect-tmux.ts`** — it checks `$TMUX`, not the tmux server. **Add branded `SocketName` type** (`/^[a-z0-9-]+$/`) to prevent shell injection in `run-shell` commands.

---

## Phase 13a — Interactive Step Mode

**Goal:** Mark steps as interactive. Foreground takeover. No tmux dependency.

### Step 1: Extend ProcessService

**Files:** `src/services/process/process-service.ts`, `bun-process-service.ts`, `fake-process-service.ts`

Add `ProcessHandle` base, `ForegroundHandle` alias, `spawnForeground()`. Bun adapter: `Bun.spawn({ stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })`. Fake: `.whenForeground(argv).respondWith({ exitCode })`. Unify `FakeResponse.exit` → `exitCode` naming.

**Tests:** `it('returns the scripted exit code when a foreground process completes')` (+ 2 more fake tests), real BunProcessService exits 0 (1).

### Step 2: Add StepMode + InteractiveResult types

**Files:** `src/core/types.ts`

`StepMode = 'interactive' | 'autonomous'`. `InteractiveResult { exitCode, durationMs, sessionId }`. `InteractiveResultSchema` with `satisfies z.ZodType<InteractiveResult>`. Add `mode?: StepMode` to `StepEntry`.

**Tests:** Schema round-trip (2), compile-time `Expect<Equal<>>` assertions (1).

### Step 3: Add mode to AgentStepConfig + RunOverrides

**Files:** `src/core/step.ts`, `src/core/workflow.ts`

Two `step.define` overloads: interactive (→ `Step<InteractiveResult>`, no `returns`) and autonomous (→ `Step<T>`). `RunOverrides` gains `mode?: StepMode`. `RunFn` gets overloads so `mode: 'interactive'` override returns `Promise<InteractiveResult>`.

**Tests:** Default mode (1), override precedence (1), compile-time overload inference (1).

### Step 4: Branch ClaudeRunner.buildCommand

**Files:** `src/runners/types.ts`, `src/runners/claude/claude-runner.ts`

Interactive: `['claude', '--session-id', uuid, '--', prompt]` (no `--bare`/`-p`/`--output-format`/`--verbose`). `--` flag terminator prevents prompt-as-flag injection. Apply flag denylist in both modes. Call `buildClaudeEnv()` for both modes (no env leakage). Flip `supports.interactive` to `true`.

**Tests:** Interactive argv (2), autonomous unchanged (1), denylist applied in interactive (1).

### Step 5: Add runInteractive executor

**Files:** `src/runners/execute.ts`

`runInteractive(runner, ctx, deps)` → `{ exitCode: number, durationMs: number }` (inline type, no third result type). Calls `spawnForeground`, awaits exit. No NDJSON parsing. Share `safeKill(handle: ProcessHandle)` with `runRunner`.

**Tests:** Unit with FakeProcessService (2), integration mocked round-trip (1).

### Step 6: Wire into workflow.ts

**Files:** `src/core/workflow.ts`, `src/core/errors.ts`, `src/core/execution-context.ts`

New `runInteractiveStep()` helper. Mode resolution: `override.mode > config.mode > 'autonomous'`. Guards throw new error types (`InteractiveParallelError`, `RunnerCapabilityError`). TTY guard: check `process.stdin.isTTY` — throw if no TTY and no `onInteractive` handler.

**Agent-native hooks on WorkflowDeps:**
- `onInteractive?: (ctx: InteractiveContext) => Promise<InteractiveResult>` — decouples interactive from TTY
- `onStepEvent?: (event: StepLifecycleEvent) => void` — real-time step:start/complete/failed/cached events
- `generateSessionId?: () => string` — defaults to `crypto.randomUUID()`, injectable for tests

SIGINT handler: install before `spawnForeground().wait()`, restore in finally. On success: persist `InteractiveResult`. On non-zero: throw `StepError`.

**Tests (use `buildTestRun()` + `assertMemoized()`):** Mode resolution (3), parallel guard (2), schema rejection (1), runner capability (1), full mocked round-trip (3), resume caching (1), real Claude gated (1).

### Step 7: Barrel exports + phases doc update

**Files:** `src/core/index.ts`, `src/runners/index.ts`, `docs/plans/implementation-phases.md`

**Definition of Done (13a):** All new code under `src/<module>/`, all tests under `tests/<layer>/<module>/`. No file > 300 lines, no function > 60 lines. `bun run check` green. Tests at every layer. PR lists tests per layer. Full-sentence test names. CLAUDE.md honored. Brainstorm updated to match AD-5.

---

## Phase 13b — Tmux Pane Management

**Goal:** Two-pane tmux layout. All tmux logic in one service.

### Step 1: TmuxService interface + types

**Files:** `src/services/tmux/tmux-service.ts`

Branded types: `PaneId` (`/^%\d+$/`), `SocketName` (`/^[a-z0-9-]+$/`). `TmuxCommandError` (following `GitCommandError` pattern). Every method returns `Promise`, takes `socket: SocketName`, is JSDoc'd.

**11 methods:** `createSession`, `splitPane` → `PaneId`, `sendKeys`, `waitFor`, `signalChannel`, `setOption`, `setHook`, `displayMessage` → `string`, `killPane`, `attachSession`, `selectPane`. Defer `capturePane`, `pipePane`, `listPanes` to 13c.

### Step 2: FakeTmuxService (before real impl — tests next)

**Files:** `src/services/tmux/fake-tmux-service.ts`

Command-recording hybrid (setter + spy). `recordedCalls` accessor. Scriptable returns: `setDisplayResult()`, `nextPaneId()`. ES `#private` fields. Document hybrid pattern in file header.

### Step 3: Write tests

Tests for interface contracts, fake recording, fake scripting. Full-sentence names.

### Step 4: RealTmuxService

**Files:** `src/services/tmux/real-tmux-service.ts`

File-header comment: "Named `RealTmuxService` (not `BunTmuxService`) because it wraps `ProcessService`, not Bun APIs." Array-based argv for all commands (never shell strings). Hardcoded `run-shell` templates with `SocketName` substitution only. Dedicated env for tmux commands: `PATH`, `HOME`, `LANG` only. `-f /dev/null` on `new-session`. Validate `displayMessage` output is non-empty (exit 0 with empty = invalid pane).

### Step 5: Pane lifecycle (inlined into execution wiring)

Session init (once): `setOption('remain-on-exit', 'on')` + `setHook -g pane-died` (global hooks only — per-pane hooks have bugs). Per-step: `splitPane` → `selectPane` (for interactive) → `waitFor` (with timeout) → `displayMessage` → `killPane`/preserve.

**`waitFor` timeout:** Race against a timer. Default 60min. Clear error on timeout.

### Step 6: CLI flags + auto-detection

**Files:** `src/cli/main.ts`, `src/cli/deps.ts`, `src/cli/detect-tmux.ts`

Two flags: `--tmux`, `--observe` (implies `--tmux`). No `--single-pane`. No `$TMUX` auto-detection. `Bun.which('tmux')` + version check (`tmux -V`, enforce >= 3.2). `isInsideTmux()` standalone function. Pane dimensions: left 30%, right 70%, window 200x50.

**Tests (13b):**
- Unit — argv construction per TmuxService method (8+), FakeTmuxService recording+scripting (5)
- Integration (mocked) — RealTmuxService + FakeProcessService (5)
- Integration (real, gated `tmux -V`) — create/split/sendkeys/wait/concurrent sockets (4). `afterEach: kill-server`.
- Shell metacharacter test for sendKeys, fast-exit race test for hook-before-spawn.

**Definition of Done (13b):** `bun run check` green. Real tmux tests pass. Branded types with validation. PR lists tests per layer. Full-sentence test names. Phase 12 (CLI) must land first.

---

## Phase 13c — Status Pane + Observe Polish

**Goal:** Left-pane status renderer. Observe mode wiring.

### Step 1: Pure status renderer

**Files:** `src/observability/status-pane.ts`

`renderStatusPane(state, opts) → string[]` — pure, no I/O. Glyphs: `●` running, `○` pending, `✓` completed, `✗` failed, `↺` cached, `⟳` interactive. Elapsed time per step. Strip ANSI escapes from user text. Also export `StepStatusRecord[]` for agent-native structured access. Extend `glyphs()` in `src/cli/format.ts` (don't duplicate).

### Step 2: Status update loop

**Files:** `src/observability/status-loop.ts`

Left pane runs `cat` (not shell — no PS1 pollution). **Concatenate** all lines into single `sendKeys` call (14.3ms vs 92.6ms). Clear with `\x1b[2J\x1b[H` before each render. Rendering guard (skip tick if busy). Return `{ stop: () => void }` handle — wire into workflow teardown `finally` block. Start with state-change-only rendering; add 1s timer tick later if needed.

### Step 3: Observe mode wiring

Add `capturePane`, `pipePane`, `listPanes` to TmuxService. Use `pipe-pane -O` for observe (orchestrator spawns agent normally, tmux tees stdout). No observe formatter — raw stdout per brainstorm decision. Add `onEvent?: (event: RunnerEvent) => void` to runner execution deps.

**Tests (13c):** Glyph/state snapshots (6), elapsed time formatting (2), ANSI stripping (1), FakeTmuxService integration (2), real tmux gated (1). Full-sentence test names.

**Definition of Done (13c):** `bun run check` green. Status loop returns stop handle. PR lists tests per layer.

---

## Testing Strategy

Three layers per project convention. **Full-sentence test names required.** Use `buildTestRun()`, `assertMemoized()` helpers. Real tests gated with `describe.skipIf`. Filename: `*-real.integration.test.ts`.

### Test file plan (11 files, consolidated from 14)

```
tests/unit/services/process/foreground.test.ts         # 13a
tests/unit/core/interactive-mode.test.ts               # 13a
tests/unit/runners/claude/interactive-command.test.ts   # 13a
tests/unit/runners/execute-interactive.test.ts          # 13a
tests/integration/core/interactive-workflow.test.ts     # 13a
tests/unit/services/tmux/tmux-service.test.ts          # 13b
tests/integration/services/tmux/tmux-integration.test.ts # 13b
tests/integration/services/tmux/tmux-real.integration.test.ts # 13b
tests/unit/observability/status-pane.test.ts           # 13c
tests/integration/observability/status-loop.test.ts    # 13c
tests/integration/observability/status-real.integration.test.ts # 13c
```

---

## Edge Cases

| Scenario | Behavior |
|---|---|
| Tmux not installed / < 3.2 + `--tmux` | Error at flag parse with version check |
| Interactive + Codex | `RunnerCapabilityError` at run() |
| Interactive inside `parallel()` | `InteractiveParallelError` (via AsyncLocalStorage) |
| Interactive + `returns:` | Compile error (overloads) + runtime guard |
| Non-zero interactive exit | StepError; resume re-runs |
| Exit code 130 (Ctrl-C) | StepError (configurable cancellation handling) |
| Ctrl-C during foreground | Parent traps SIGINT; Claude handles; orch resumes |
| SIGTERM/SIGHUP | Forward to child, set state crashed, cleanup tmux |
| No TTY + library API | Error if no `onInteractive` handler provided |
| User closes tmux window | Session persists background; interactive hangs (no timeout in 13a) |
| Multiple concurrent workflows | Separate sessions (`orch-<runId>`) on same socket |
| `displayMessage` on invalid pane | Exit 0 + empty output — validate non-empty |
| `wait-for` signal not queued | Pane-specific channels (`pane-exit-#{hook_pane}`) prevent signal loss |
| `brainstorm` output in downstream prompt | InteractiveResult has no content — needs transcriptPath |

## Security Checklist

| Severity | Finding | Mitigation | Phase |
|---|---|---|---|
| CRITICAL | sendKeys command injection | Array-based argv via ProcessService | 13b |
| CRITICAL | set-hook/run-shell injection | Branded SocketName; hardcoded templates | 13b |
| HIGH | Prompt as positional argument | `--` flag terminator | 13a |
| MEDIUM | SIGINT kills orchestrator | Trap in parent during foreground | 13a |
| MEDIUM | ANSI escape injection | Strip in renderStatusPane | 13c |
| MEDIUM | Tmux env leakage | Dedicated env: PATH, HOME, LANG only | 13b |
| LOW | Interactive env leakage | buildClaudeEnv() for both modes | 13a |
| LOW | State file permissions | .orch/state/ mode 0700 | 13a |

## Agent-Native Hooks (NEW)

| Hook | Location | Purpose |
|---|---|---|
| `onInteractive` | WorkflowDeps | Decouple interactive from TTY; agents supply custom handler |
| `onStepEvent` | WorkflowDeps | Real-time step lifecycle (start/complete/failed/cached) |
| `onEvent` | Runner execution deps | Pipe RunnerEvent stream to any consumer |
| `StepStatusRecord[]` | status-pane.ts export | Structured status data without parsing rendered text |
| `mode` in StepEntry | state-store.ts | Agents distinguish interactive from autonomous in state.json |

## Dependencies

- Phase 12 (CLI) for argv parser — **must land before 13b**
- tmux >= 3.2 for `wait-for`, format variables, `remain-on-exit failed`
- No npm packages — `TmuxService` shells out via `ProcessService`

## New Files Created

- `src/services/tmux/tmux-service.ts` — interface + PaneId, SocketName, TmuxCommandError
- `src/services/tmux/real-tmux-service.ts` — real adapter (via ProcessService)
- `src/services/tmux/fake-tmux-service.ts` — recording fake
- `src/services/tmux/index.ts` — barrel
- `src/core/execution-context.ts` — AsyncLocalStorage for parallel depth
- `src/cli/detect-tmux.ts` — isInsideTmux pure function
- `src/observability/status-pane.ts` — pure renderer + StepStatusRecord
- `src/observability/status-loop.ts` — update loop with stop handle
- `src/observability/index.ts` — barrel
