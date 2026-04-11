---
date: 2026-04-09
status: active
topic: Phased implementation roadmap for orch
---

# Implementation Phases

This document is the living roadmap for building `orch`. Each phase is a PR-sized slice with a concrete **Definition of Done**. Phases land in order; every phase must pass `bun run check` before the next one starts.

The design context lives in [`../brainstorms/2026-04-08-claude-orchestrator-brainstorm.md`](../brainstorms/2026-04-08-claude-orchestrator-brainstorm.md) and [`../getting-started.md`](../getting-started.md). The non-negotiable project rules live in [`/CLAUDE.md`](../../CLAUDE.md). Testing discipline lives in [`.claude/skills/testing-strategy/SKILL.md`](../../.claude/skills/testing-strategy/SKILL.md).

## Guiding principles

The three design drivers, in priority order:

1. **Testability** — architecture enforces mockability. All I/O crosses a `*Service` port; tests fake ports, never internal modules.
2. **Readability** — tests read as prose, file/function sizes stay small, CLAUDE.md rules are short and enforced by tooling.
3. **Maintainability** — each phase is small and independently verifiable; runners are adapters; the core never imports a concrete runner.

## Tech stack (locked)

| Concern | Choice |
|---|---|
| Runtime | Bun ≥ 1.2 |
| Language | TypeScript strict + `noUncheckedIndexedAccess` |
| Lint + format | Biome ≥ 2.4.10 |
| Test runner | `bun test` |
| Schema validation | Zod |
| Subprocess | `Bun.spawn` behind a `ProcessService` port |

## The phases

Legend: ☐ not started · ◐ in progress · ✓ landed

### Phase 0 — Infrastructure & rules ✓

**Goal:** a green empty project with every guard-rail in place.

**Deliverables:**
- `package.json`, `tsconfig.json`, `biome.json`, `.editorconfig`, `.gitignore`
- `.claude/settings.json` (hooks), `.claude/hooks/warn-big-file.sh`
- `.claude/skills/{testing-strategy,runner-author,phase-implementer}/SKILL.md`
- `CLAUDE.md`, `README.md`
- `src/index.ts` (empty barrel), `tests/unit/placeholder.test.ts`
- `bun run check` passes

**Definition of Done:** running `bun run check` on a freshly cloned repo produces zero warnings and zero errors.

**Landed:** 2026-04-09

---

### Phase 1 — `ProcessService` port + Bun adapter + Fake adapter ✓

**Goal:** the single seam between the codebase and every subprocess it will ever spawn.

**Deliverables:**
- `src/services/process/process-service.ts` — `interface ProcessService { spawn(opts): SpawnHandle }` where `SpawnHandle` exposes `stdout` (`AsyncIterable<string>`), `stderr`, `wait(): Promise<{ exitCode: number }>`, `kill()`.
- `src/services/process/bun-process-service.ts` — real adapter wrapping `Bun.spawn` with line-framed stdout.
- `src/services/process/fake-process-service.ts` — scriptable: `.when(cmd).respondWith({ stdout: [...], exit: 0 })`.
- `src/services/fs/` and `src/services/clock/` stubs (needed by later phases).

**Tests:**
- **Unit** — `FakeProcessService` returns scripted stdout, respects exit codes, supports multiple scripted invocations.
- **Integration** — `BunProcessService` spawns `echo hello` on a real shell and reads it back. (No Claude/Codex yet.)

**Definition of Done:** Any file importing `Bun.spawn` outside this folder fails the `bun run check` gate (enforced via a grep-based pre-lint step or a custom Biome rule).

**Landed:** 2026-04-10

---

### Phase 2 — `Runner` port + `FakeRunner` + `runRunner` ✓

**Goal:** the abstraction the workflow core will talk to. No real CLI yet. Three-layer split: pure adapter (`Runner`), executor glue (`runRunner`), test double (`FakeRunner`).

**Deliverables:**
- `src/runners/runner.ts` — `Runner` interface (`name`, `supports`, `buildCommand`, `parseEvents`, `extractStructuredOutput`), `RunnerContext`, `RunnerEvent` union (`TerminalEvent` + `InfoEvent`), `defineRunner()` factory, `isTerminalEvent` predicate. `Path` imported from `src/services/types.ts` (already shipped by Phase 1).
- `src/runners/execute.ts` — `runRunner(runner, ctx, deps)` executor that pumps a runner against a `ProcessService` and produces a `RunnerResult`.
- `src/runners/fake/fake-runner.ts` — scriptable `FakeRunner` class with FIFO script queue, per-instance nonce, invocation tracking.
- `src/runners/index.ts` — single public barrel.
- `RunnerContext` type: `cwd: Path`, `env`, `prompt`, `extraArgs` only. (`schema`, `paneHandle`, `transcriptPath`, `secrets` deferred to their respective phases — YAGNI.)

**Tests:**
- **Unit** — `FakeRunner` can be configured to emit a sequence of events, return a structured value, fail with an error, track invocation count, consume scripts FIFO, and throw on empty queue.
- **Unit** — `defineRunner()` validates required fields; `isTerminalEvent` narrows correctly.
- **Integration (mocked edges)** — `FakeRunner → runRunner → FakeProcessService` round-trips events, terminal event, structured output, measures `durationMs` via injected `Clock`.

**Detailed plan:** [`docs/plans/2026-04-09-feat-phase-2-runner-port-plan.md`](2026-04-09-feat-phase-2-runner-port-plan.md)

**Landed:** 2026-04-10

---

### Phase 3 — State store + run IDs ✓

**Goal:** deterministic, inspectable persistence. Everything the workflow needs to memoize.

**Deliverables:**
- `src/state/run-id.ts` — `RunId` branded type + `generateRunId()` with clock-derived slug (`r-YYYY-MM-DD-xxxx`).
- `src/state/state-store.ts` — `FileStateStore` with atomic writes (tmp + rename); `RunState` with `schemaVersion: 1` and `status`; `StepEntry` `{ name, value, startedAt, endedAt, artifacts }` (dropped `durationMs` — redundant with `endedAt - startedAt`); `StateCorruptionError` with Zod issues; Zod validation on load + `JSON.stringify` guard on save.
- `src/state/run-registry.ts` — `FileRunRegistry` with `listRuns`, `findLatest`, `findByPrefix`.
- `src/state/index.ts` — public barrel.

**Tests:**
- **Unit** — run-id: format, stability, date portion, slug padding, validation (8 tests).
- **Unit** — state store: round-trip, overwrite, missing files, corrupted JSON, atomic write safety, stringify error wrapping (8 tests).
- **Unit** — run registry: empty/missing dirs, sorted listing, non-matching entry filtering, latest, prefix search (8 tests).
- **Integration** — state store + run registry against real temp directories via `BunFsService` (3 tests).

**Detailed plan:** [`docs/plans/2026-04-10-feat-phase-3-state-store-run-ids-plan.md`](2026-04-10-feat-phase-3-state-store-run-ids-plan.md)

**Landed:** 2026-04-10

---

### Phase 4 — `step.define` + `workflow` + `run` + memoization ✓

**Goal:** the core DSL. Runs workflows powered **entirely by `FakeRunner`**.

**Deliverables:**
- `src/core/step.ts` — `step.define(name, config)`.
- `src/core/workflow.ts` — `workflow(name, fn)` returning an executor; `run(STEP, overrides)` name-keyed memoization against `StateStore`.
- `src/core/types.ts` — branded `Path`, `StepName`, `RunId`.

**Tests:**
- **Unit** — memoization: step runs once, second invocation returns cached value, invocation count stays at 1.
- **Unit** — overrides at call site don't change the memoization key.
- **Unit** — crash mid-workflow, resume re-executes top-to-bottom but skips completed names.
- **Integration** — a 4-step fake workflow end-to-end; inspect `state.json`.

**Detailed plan:** [`docs/plans/2026-04-10-feat-phase-4-step-workflow-run-plan.md`](2026-04-10-feat-phase-4-step-workflow-run-plan.md)

**Landed:** 2026-04-10

---

### Phase 5 — Real `ClaudeRunner` (minimal: prompt only, no schema, no validate) ✓

**Goal:** first real end-to-end execution. **This is the "real feedback early" milestone.**

**Deliverables:**
- `src/runners/claude/claude-runner.ts` — Zod schemas, NDJSON parser, env allowlist builder, `claude()` factory via `defineRunner()`. `buildCommand` producing `claude --bare -p <prompt> --output-format stream-json --verbose --no-session-persistence`.
- `src/runners/claude/index.ts` — module barrel.
- `claude()` factory exported from `src/runners/index.ts`.

**Tests:**
- **Unit** — `buildCommand` argv construction, env allowlist, option combinations (`tests/unit/runners/claude/build-command.test.ts`). NDJSON parser, success/error envelopes, malformed JSON, `extractStructuredOutput` (`tests/unit/runners/claude/parse-events.test.ts`).
- **Integration (mocked)** — full round-trip `ClaudeRunner → runRunner → FakeProcessService` from fixture NDJSON (`tests/integration/runners/claude/claude-mocked.test.ts`).
- **Integration (real, gated `RUN_REAL_CLAUDE=1` + `Bun.which('claude')`)** — real `claude` run with "Reply with exactly: OK" prompt (`tests/integration/runners/claude/claude-real.test.ts`).
- **E2E-lite (gated)** — workflow DSL + real ClaudeRunner, persisted state inspection (`tests/integration/runners/claude/claude-e2e-lite.test.ts`).

**Detailed plan:** [`docs/plans/2026-04-11-feat-phase-5-claude-runner-plan.md`](2026-04-11-feat-phase-5-claude-runner-plan.md)

**Definition of Done:** `RUN_REAL_CLAUDE=1 bun run test:int` produces a passing real run on a dev machine in under 30 s.

**Landed:** 2026-04-11

---

### Phase 6 — Validators ☑

**Goal:** post-exit assertions land with a readable DX.

**Deliverables:**
- `src/validators/file-produced.ts` — glob check.
- `src/validators/git-diff-created.ts` — takes `GitService` via DI.
- `src/validators/git-commit-created.ts`.
- `src/validators/check.ts` — inline escape hatch.
- `src/validators/define-validator.ts` — named reusable factory.
- Wire `validate:` into `workflow.run()`; array form runs all validators.

**Tests:**
- **Unit** — each built-in validator with a fake service; pass / fail / error paths. Validator names appear verbatim in failure messages.
- **Unit** — `check(fn)` accepts `true | string | { ok, reason }`.
- **Integration** — `fileProduced` against a real temp dir; `gitDiffCreated` against a real temp git repo created by `tests/helpers/temp-git-repo.ts`.

**Landed:** 2026-04-11 — see [`2026-04-11-feat-phase-6-validators-plan.md`](2026-04-11-feat-phase-6-validators-plan.md). Ships the minimal `GitService` port (headSha, hasDiffSince, diffSinceSha — `isClean` deferred to Phase 10), `StepEntry` schema v2 with security-constrained `preRunSnapshot.headSha`, lazy baseline capture via `needs: ['headSha']` capability, serial no-fail-fast validator loop, and the module-level named validator registry ready for Phase 14's out-of-process `orch validate` CLI.

---

### Phase 7 — Typed returns (`schema`) via Claude `--json-schema` ☐

**Goal:** typed handoffs between steps. The killer feature from the brainstorm.

**Deliverables:**
- `src/core/schema.ts` — `schema(zod)` wrapper; `returns:` key on steps.
- Extend `ClaudeRunner` to accept a schema, append `--json-schema '<inline>'`, parse `structured_output` from the final envelope, validate against Zod.
- `FakeRunner` gains `returns: 'fixture.json'` support.

**Tests:**
- **Unit** — schema → command-line flag → fixture NDJSON → parsed value. Invalid value throws a readable error pointing at the Zod path.
- **Integration** — real Claude emits schema-conformant JSON for a simple 3-field schema.

---

### Phase 8 — `parallel()` helper ☐

**Goal:** deterministic concurrency with resume support.

**Deliverables:**
- `src/core/parallel.ts` — both forms (`parallel([promises])`, `parallel(items, fn)`).
- Concurrency cap (`{ concurrency }`).
- Stable per-branch names for memoization.

**Tests:**
- **Unit** — heterogeneous: two fake runners run concurrently, both persist, second invocation returns cached.
- **Unit** — homogeneous: three items, three step entries with `as: 'review-<item>'`.
- **Unit** — concurrency cap never exceeds the configured limit (measured via a fake that blocks on a latch).
- **Integration** — parallel with two different real runners is gated by Phase 9.

---

### Phase 9 — Real `CodexRunner` ☐

**Goal:** second real runner so parallel multi-agent works.

**Deliverables:**
- `src/runners/codex/codex-runner.ts` — `codex exec --json --skip-git-repo-check --sandbox workspace-write -c approval_policy='"never"' --output-schema <file>` command shape.
- Session ID capture from first `thread.started` event.
- End-of-run on `turn.completed` / `turn.failed`.
- Preflight: `codex --version` parsed, fail fast if `< 0.118.0`.

**Tests:**
- **Unit** — `FakeProcessService` + fixture `codex/with-output-schema.jsonl` → parsed structured output.
- **Integration (auto-skipped)** — real `codex exec` with a tiny prompt.
- **Integration** — `parallel()` with `ClaudeRunner` and `CodexRunner` against real CLIs (gated by both env vars).

---

### Phase 10 — `GitService` + `commit()` primitive ☐

**Goal:** commits as first-class workflow entries.

**Deliverables:**
- `src/services/git/git-service.ts` port.
- `src/services/git/real-git-service.ts` adapter.
- `src/services/git/fake-git-service.ts`.
- `src/core/commit.ts` — `commit(message, opts)` builds a step under a reserved name prefix (`commit:<message>`).

**Tests:**
- **Unit** — `commit()` calls `GitService.stageAll` then `GitService.commit`; memoized by commit name.
- **Integration** — real git in a temp repo.

---

### Phase 11 — Resume end-to-end ☐

**Goal:** crash + resume with zero hand-holding.

**Deliverables:**
- `workflow.resume(runId)` re-runs the function with a `StateStore` pre-loaded with the crashed state.
- Resume skipping happens transparently inside `run(STEP)`.

**Tests:**
- **Integration** — `FakeRunner` throws mid-phase; resume completes; crashed step re-runs from scratch; later steps hit the cache.
- **Integration** — same pattern with `ClaudeRunner` + `FakeProcessService` scripted to fail.
- **E2E (gated)** — resume against real Claude.

---

### Phase 12 — CLI ☐

**Goal:** users can invoke the orchestrator from the terminal.

**Deliverables:**
- `src/cli/index.ts` — argv parser (tiny; no framework).
- `orch run <file.ts>`, `orch resume <id>`, `orch runs`, `orch status <id>`, `orch dry-run <file.ts>`.
- `bin` entry in `package.json` (already set in Phase 0).

**Tests:**
- **Unit** — argv → command dispatch; help output; error messages.
- **E2E** — `bun x orch run tests/fixtures/workflows/hello.ts` against `FakeRunner` in a fresh temp cwd. Golden `state.json`.
- **E2E (gated)** — same against real Claude.

---

### Phase 13 — Tmux observability ☐

**Goal:** left status pane + right agent pane on a dedicated socket.

**Deliverables:**
- `src/services/tmux/tmux-service.ts` port + `real-tmux-service.ts` + `fake-tmux-service.ts`.
- `src/observability/status-pane.ts` — renders from `state.json` + small in-memory tail.
- Pane lifecycle (create, split, `remain-on-exit`, poll `#{pane_dead}`).

**Tests:**
- **Unit** — status pane text rendering is a pure function of state + tail; snapshot tests for every glyph (`●`, `○`, `✓`, `⟳`, `✗`, `↯`, `↺`).
- **Integration** — `FakeTmuxService` records commands; assertions about lifecycle.
- **Integration (gated by `tmux -V`)** — real tmux on the dedicated `-L orchestrator` socket.

---

### Phase 14 — Claude escalation (`PreToolUse` defer + MCP fallback) ☐

**Goal:** human-in-loop for Claude.

**Deliverables:**
- `src/escalation/request-human-input.ts` — unified API.
- `src/escalation/claude-defer-hook.ts` — inline `PreToolUse` hook JSON with `permissionDecision: "defer"`; injected into Claude runs via `--settings` inline JSON.
- `src/escalation/mcp-server.ts` — fallback `orch__request_human_input` tool.
- Wire `Notification` hook as a side-channel alert.

**Tests:**
- **Unit** — hook JSON shape for known tool calls (Bash on a deny-list).
- **Unit** — MCP tool blocks until a file/socket is written.
- **Integration (gated)** — real Claude hits a deferred tool call; orchestrator resumes it after a test-driven "allow".

---

### Phase 15 — Codex escalation (blocking MCP + short-run pattern) ☐

**Goal:** human-in-loop for Codex given its thin primitives.

**Deliverables:**
- `src/escalation/codex-short-run.ts` — helper that takes a `{ status, question? }` schema, runs `codex exec`, parses final `agent_message`, dispatches to human on `needs_human`.
- Blocking MCP tool variant for users who accept the #16685 caveat.

**Tests:**
- **Unit** — short-run helper routes `status: "needs_human"` to `requestHumanInput`.
- **Integration (gated)** — real Codex emits a `needs_human` result; orchestrator handles it and resumes with `codex exec resume <thread_id>`.

---

### Phase 16 — Full compound e2e + runner author docs ☐

**Goal:** the brainstorm's core example (`brainstorm → plan → parallel research → work → parallel review → commit`) runs.

**Deliverables:**
- `tests/e2e/brainstorm-plan-work-review.e2e.test.ts` — full flow with real agents, gated by `RUN_REAL_E2E=1`.
- `tests/e2e/brainstorm-plan-work-review.mocked.test.ts` — same flow, `FakeRunner` scripted from fixtures; runs on every CI.
- `docs/runner-author.md` — Aider example demonstrating `defineRunner` in ~30 lines.
- `src/runners/index.ts` publicly exports `defineRunner`.

**Definition of Done:** mocked e2e passes on every `bun test`; real e2e passes on a dev machine with both CLIs installed; an external Aider wrapper under `tests/fixtures/runners/aider.ts` runs a 1-step workflow.

---

## Verification gates

For every phase, the gate is:

```bash
bun run check            # lint + typecheck + unit + integration (mocked)
```

At the Phase 5, Phase 9, and Phase 16 milestones, additionally run the real-CLI gates:

```bash
RUN_REAL_CLAUDE=1 bun run test:int
RUN_REAL_CODEX=1  bun run test:int
RUN_REAL_E2E=1    bun run test:e2e
```

Every phase's PR description must list which tests were added at each layer (unit / integration-mocked / integration-real / e2e). Missing a layer is a review blocker unless the phase explicitly has nothing at that layer (e.g., Phase 0 has no integration tests).

## How to mark a phase as landed

1. Update this document: flip the phase's status glyph from ☐ to ✓ and add a `**Landed:** YYYY-MM-DD` line at the end of the phase block.
2. Commit as part of the phase's PR.
3. Load the `phase-implementer` skill to start the next phase.
