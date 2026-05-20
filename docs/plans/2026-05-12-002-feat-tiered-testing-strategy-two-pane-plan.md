---
date: 2026-05-12
status: active
type: feat
topic: tiered-testing-strategy-two-pane
origin: docs/brainstorms/2026-05-12-feat-tiered-testing-strategy-two-pane-brainstorm.md
---

# feat: Tiered Testing Strategy for the Two-Pane Host

## Summary

Add a reusable in-tree real-tmux test harness under `tests/helpers/real-tmux/` (generalized from `tests/integration/hosts/two-pane/end-of-run.real.integration.test.ts`), land starter test sets at Tier 1 (real-tmux + `FakeRunner`), Tier 2 (Ink projection), and Tier 4 (real-tmux + real-CLI, env-gated), audit ~40 files under `tests/{unit,integration}/hosts/two-pane/**` with per-file Keep/Rewrite/Delete dispositions, and migrate the two existing `tests/e2e/` real-CLI files onto the new harness. The harness is agent-agnostic so a Tier 1 flow promotes to Tier 4 by swapping the agent slot.

---

## Problem Frame

Right-pane regressions ship despite a green test suite. Recent examples (commit history): right pane empty after `step:start`; right pane unformatted; right pane not switched after step transitions; follow-live landing on the wrong source; replay opening the wrong content. Diagnosis today is "see it live → describe symptom → fix → ship" with no automated regression net for visible-pane behavior.

Most existing two-pane tests assert on `FakeTmuxService.recordedCalls` (e.g., `splits.length === 1`, argv shapes, lifecycle event records). These verify the fake service received the right poke; they cannot fail when the visible pane is empty, unformatted, or showing the wrong content. The two regression tests landed alongside the most recent right-pane fix (`autonomous-live-pane-shows-content-immediately`, `right-pane-live-doubling.real.integration`) fell back to file-existence and tee-byte proxies because the harness for "actually inspect the visible pane" is one-off — only `end-of-run.real.integration.test.ts` boots a real tmux server and `capturePane`s the result, and there is no reusable helper.

When tests pass green despite visible-pane breakage, the implementation-detail tests become a *source* of risk — they create false confidence and refactor churn without catching the bug class that ships. This plan re-grounds the two-pane test surface around visible-pane outcomes.

(See origin: `docs/brainstorms/2026-05-12-feat-tiered-testing-strategy-two-pane-brainstorm.md`.)

---

## Requirements

Carried from the brainstorm. R-IDs are stable across plan and origin.

**Tier definitions**
- R1. Four test tiers covering two-pane behavior, each scoped to a specific bug class — Tier 1 real-tmux behavioral (visible-pane content + view state); Tier 2 Ink projection (state→view, key→intent, footer/banner); Tier 3 argv contract (`RealTmuxService` + `FakeProcessService`); Tier 4 real-tmux + real-CLI E2E.
- R2. Each tier has a unique responsibility; tests belong to exactly one tier. The "mocked + real" pair (Tier 1 / Tier 4) is the only sanctioned duplication.

**Real-tmux harness**
- R3. Reusable real-tmux harness shared by Tier 1 and Tier 4. Capabilities: boot an isolated tmux server on a per-test socket; tear it down on exit; mount a real `TmuxHost` against real services with a configurable agent slot per step; capture left/right visible pane contents as text (ANSI-stripped by default); send keys (literal and named: `Enter`, `Up`, `Down`, `F`, etc.); wait for a text predicate on a pane with a bounded timeout; run a workflow to completion or to a pause point.
- R4. Harness auto-skips when `tmux` is not on `PATH` (existing `Bun.which('tmux')` convention).
- R5. Harness is agent-agnostic: the agent for each step is a parameter, not baked into the harness.
- R6. Tier 4 is gated by `Bun.which('claude'|'codex')` *and* `RUN_REAL_TMUX_E2E=1`.

**Audit triage rule**
- R7. Audit every file under `tests/unit/hosts/two-pane/**` and `tests/integration/hosts/two-pane/**` against a written triage rule. Three dispositions: **Keep** (no higher tier covers and protects a real bug class — includes Tier 3 argv tests on the tmux seam); **Rewrite** (real behavior, implementation-detail assertion — rewrite to assert visible-pane outcome or projection); **Delete** (re-states implementation detail and the behavior is or will be covered at a higher tier).
- R8. The triage rule is articulated as concrete criteria and applied uniformly. Primary criterion: *"Would this test still pass if the visible pane were empty / wrong / unformatted? If yes, demote or delete."*

**Coverage starter set**
- R9. Tier 1 starter set covers the named bug classes — autonomous `step:start` visible content within bounded window; replay shows same transcript as live; follow-live (`F`) swaps back to running step's source after past replay; interactive `step:start` shows prompt within bounded window; replay revisits do not respawn the pane (warm-cache invariant); banner state at info/error TTL; view-mode footer reflects current mode.
- R10. Tier 2 starter set covers view-mode footer transitions; key→intent mapping for the published keymap (`Up`, `Down`, `Enter`, `F`, `?`, `q`, `Esc`); banner rendering at each kind/state; end-of-run footer for terminal-state runs; empty-steps state.
- R11. Tier 4 starts narrow — one autonomous-only multi-step flow and one mixed flow with at least one interactive step. Both reuse the Tier 1 harness, swapping the agent slot.

**Existing E2E migration**
- R12. `tests/e2e/resume-real-claude.test.ts` and `tests/e2e/steps-tui-e2e.test.ts` migrate onto the new harness. After migration there is one canonical real-tmux test shape, parameterized by agent and gating flag.

---

## Key Technical Decisions

- **Harness lives under `tests/helpers/real-tmux/`** with a barrel `index.ts`. Mirrors the existing `tests/helpers/` convention (flat helpers like `fake-host.ts`, `test-deps.ts`). The harness is a fixture module, not a test runner — exports a `createRealTmuxFixture(opts)` factory plus typed pane handles.
  - *Rationale:* The existing prior art (`end-of-run.real.integration.test.ts`) already implements ~80% of the boot/teardown ceremony; absorbing it into a shared helper costs less than adopting any external framework. Co-locating with `tests/helpers/` matches mental model.

- **Fixture-factory shape, not class API.** `createRealTmuxFixture({ socket?, stateBase?, ... })` returns a typed handle. Disposable cleanup via explicit `await fixture[Symbol.asyncDispose]?.()` in `afterEach`, with optional `using` ergonomics where the test file opts in.
  - *Rationale:* Matches the project's "fakes injected via constructor" idiom. No hidden module state. Cleanup is explicit and grep-able.

- **Pane handles use predicate-based wait, not polling helpers in test bodies.** `right.waitForText(needle, { timeoutMs })` and `right.waitFor(predicate, { timeoutMs })` are the surface; tests do not implement their own `wait(1500)` and `capture()` retry loops.
  - *Rationale:* The current prior art uses fixed `await wait(1500)` followed by `capturePane` — fragile and slow. A bounded predicate wait is faster on the happy path and surfaces real timeout failures with diagnostic context. (See origin: Outstanding Question on harness ergonomics.)

- **ANSI strip by default on capture; raw bytes are an opt-in.** `right.capture()` returns ANSI-stripped text; `right.captureRaw()` returns the raw buffer for the narrow cases that need to assert escape sequences (e.g., the existing "no caret-notation echo bytes" assertion in AE1).
  - *Rationale:* Brainstorm scope decision — text-content assertions only. Raw bytes are reachable but not the default path; reduces test coupling to terminal styling that drifts between CLI versions.

- **Audit artifact: sibling doc + per-file disposition comment.** A single canonical `docs/plans/2026-05-12-002-feat-tiered-testing-strategy-two-pane-audit.md` lists every audited file with its disposition and one-line justification. Each Keep/Rewrite file also gets a `// triage: keep|rewrite — <reason>` header comment so the disposition is grep-able from the test file itself. Deletes are tracked in the audit doc only.
  - *Rationale:* (See origin: Outstanding Question on audit doc shape.) The doc is the canonical reviewable artifact; the comments make the rule's outcome legible at the point of use without forcing a doc lookup.

- **Rollup pane treated as part of the right-pane source abstraction in v1.** No direct assertion hooks on the hidden rollup pane. `right.capture()` returns whatever pane is currently visible at the right-pane slot, including rollup view when active.
  - *Rationale:* (See origin: Outstanding Question on rollup hooks.) Brainstorm Tier 1 starter scenarios do not require it. Deferred to follow-up if a future scenario does.

- **Tier 4 env gate is `RUN_REAL_TMUX_E2E=1`.** Mirrors the existing `RUN_REAL_E2E=1` precedent in `package.json#scripts.test:e2e`. CI scheduling for Tier 4 (nightly, separate job) is deferred to follow-up — v1 is developer-opt-in.
  - *Rationale:* (See origin: Outstanding Question on Tier 4 CI cadence.) Defer the operational choice until the starter set is in place and signal-vs-noise is observable.

- **Tier 2 projection tests stay in `tests/unit/hosts/two-pane/steps-view/**`.** No new top-level grouping. Existing `ink-testing-library` and `renderToString` patterns are extended, not relocated.
  - *Rationale:* (See origin: Outstanding Question on Tier 2 location.) `ink-testing-library` is already in 5 files there; relocation would be churn without benefit.

- **Tier 3 argv tests are out of audit scope.** They live around `RealTmuxService` (`src/services/tmux/`) and assert tmux argv shapes against `FakeProcessService`. They stay as-is.
  - *Rationale:* Brainstorm scope decision (R7 names only `tests/{unit,integration}/hosts/two-pane/**`). Tmux-seam argv tests are not implementation-detail proxies for visible-pane behavior — they assert the tmux contract directly.

---

## High-Level Technical Design

This sketch illustrates the harness shape and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.

```text
createRealTmuxFixture(opts) -> Fixture
  opts:
    socketName?:      string         // default: orch-test-<pid>-<rand>
    stateBase?:       Path           // default: mkdtemp under tmpdir()
    width?:           number         // default: 200
    height?:          number         // default: 50
    skipAttach?:      true (fixed)   // tests never attach foreground
    transcriptRenderer?: Runner['toTranscriptLines']

  Fixture:
    socket:       SocketName
    stateBase:    Path
    runId:        RunId

    host:         TmuxHost                 // real services, agent slot from runWorkflow
    left:         PaneHandle               // steps-view pane
    right:        PaneHandle               // active right-pane source

    runWorkflow(steps: HarnessStep[]): Promise<{ runId, completed: boolean }>
      // steps[i].agent is a `Runner` — pass fakeAgent({...}) for Tier 1, real Runner for Tier 4
      // returns when workflow reaches terminal state or pause point

    sendKeys(input: string | NamedKey): Promise<void>
    pause(predicate: (state) => boolean, opts?): Promise<void>
    [Symbol.asyncDispose](): Promise<void>  // teardown: tmux kill-server + rm state base

  PaneHandle:
    capture(): Promise<string>              // ANSI-stripped
    captureRaw(): Promise<string>           // raw bytes (escape sequences preserved)
    waitForText(needle: string, opts?: { timeoutMs?: number; intervalMs?: number }): Promise<void>
    waitFor(predicate: (text: string) => boolean, opts?): Promise<void>
```

The fixture composes real services exactly as production does:

```text
new RealTmuxService({ processService: new BunProcessService() })
new BunFsService()
new BunClock()
createTmuxHost({ tmux, processService, fs, clock, socket, ..., skipAttach: true, skipVersionCheck: true })
```

Agent slot is per-step via the workflow descriptor — Tier 1 passes a `FakeRunner` scripted with `events`/`structuredOutput`/`failWith`; Tier 4 passes the real `ClaudeRunner` or `CodexRunner`. The test body is identical.

---

## Output Structure

The harness adds these new paths:

```text
tests/
  helpers/
    real-tmux/
      index.ts                # barrel — exports createRealTmuxFixture, types
      fixture.ts              # createRealTmuxFixture implementation
      pane-handle.ts          # PaneHandle (capture, captureRaw, waitForText, waitFor)
      workflow-driver.ts      # runWorkflow + HarnessStep types
      socket.ts               # per-test SocketName allocation + nested-tmux guard
      ansi.ts                 # re-export of stripAnsi for harness consumers
  unit/
    hosts/two-pane/
      real-tmux-harness/      # tests for the harness itself
        socket-allocation.test.ts
        pane-handle.test.ts
docs/plans/
  2026-05-12-002-feat-tiered-testing-strategy-two-pane-audit.md
```

Plus relocations and rewrites under the existing two-pane test tree per the audit (driven by U6 — paths determined by audit dispositions, not pre-declared here).

---

## Implementation Units

### U1. Real-tmux harness scaffold and lifecycle

**Goal.** Create the harness module skeleton at `tests/helpers/real-tmux/` with isolated tmux server boot, per-test socket allocation, isolated state base, nested-tmux guard, and complete teardown. Generalizes the boot/teardown ceremony from `end-of-run.real.integration.test.ts`.

**Requirements.** R3 (boot/teardown), R4 (auto-skip on missing tmux).

**Dependencies.** None.

**Files.**
- `tests/helpers/real-tmux/index.ts` (barrel)
- `tests/helpers/real-tmux/fixture.ts`
- `tests/helpers/real-tmux/socket.ts`
- `tests/helpers/real-tmux/ansi.ts`
- `tests/unit/hosts/two-pane/real-tmux-harness/socket-allocation.test.ts`

**Approach.**
- Compose `RealTmuxService`, `BunProcessService`, `BunFsService`, `BunClock` exactly as production does.
- Per-test socket name via existing `socketName(...)` smart constructor; nonce includes pid + crypto-random to survive parallel test runs.
- State base via `mkdtemp(join(tmpdir(), 'orch-harness-'))`; tracked for cleanup.
- Nested-tmux guard: throw a clear error if `process.env.TMUX` is non-empty (per `two-pane-auto-attach.md` learning).
- `[Symbol.asyncDispose]` runs `tmux -L <socket> kill-server` (best-effort, swallow errors) then `rm -rf` the state base.
- Skip mechanism: export `canRunRealTmux()` helper returning `Bun.which('tmux') !== null && !process.env.TMUX`; tests use `describe.skipIf(!canRunRealTmux())`.

**Patterns to follow.**
- Socket allocation, mkdtemp, kill-server teardown: `tests/integration/hosts/two-pane/end-of-run.real.integration.test.ts`.
- Service composition: `src/hosts/two-pane/tmux-host.ts#createTmuxHost`.
- Smart constructors: `src/services/tmux/index.ts` exports for `SocketName`, `PaneId`.

**Test scenarios.**
- The harness allocates a unique socket name on each `createRealTmuxFixture()` call; two concurrent fixtures get distinct sockets.
- The harness throws a clear error when `process.env.TMUX` is non-empty; the error names `TMUX` so the cause is obvious.
- `canRunRealTmux()` returns `false` when `Bun.which('tmux')` is `null`; returns `false` when `TMUX` is set even if `tmux` is on PATH; returns `true` only when both conditions are clear.
- After `[Symbol.asyncDispose]`, the tmux server for that socket is gone (`tmux -L <socket> list-sessions` exits non-zero) and the state base directory does not exist.
- Disposal swallows tmux-kill-server errors when the server is already gone — it does not throw.

**Verification.** `bun run check` is green. `tests/unit/hosts/two-pane/real-tmux-harness/socket-allocation.test.ts` passes on a machine with `tmux` available and auto-skips without.

---

### U2. Harness API: pane handles, key sending, workflow driver

**Goal.** Implement `PaneHandle` (`capture`, `captureRaw`, `waitForText`, `waitFor`), `sendKeys`, and `runWorkflow(steps)` with agent slot per step. Surface is identical across Tier 1 and Tier 4 — agent is the only parameter that changes.

**Requirements.** R3 (capture, sendKeys, waitFor, runWorkflow), R5 (agent-agnostic).

**Dependencies.** U1.

**Files.**
- `tests/helpers/real-tmux/pane-handle.ts`
- `tests/helpers/real-tmux/workflow-driver.ts`
- `tests/helpers/real-tmux/index.ts` (extend barrel)
- `tests/unit/hosts/two-pane/real-tmux-harness/pane-handle.test.ts`

**Approach.**
- `PaneHandle` wraps a `PaneId` plus the shared `RealTmuxService` and `SocketName`. `capture()` calls `tmux.capturePane({ socket, target })` and pipes through `stripAnsi`. `captureRaw()` returns the same buffer un-stripped.
- `waitForText(needle, { timeoutMs = 3000, intervalMs = 50 })` polls `capture()` until the needle appears or the timeout elapses; on timeout, throws an error containing the last captured frame for diagnostic context.
- `waitFor(predicate, opts)` is the predicate-based variant.
- Named keys (`Enter`, `Up`, `Down`, `F`, `?`, `q`, `Esc`) map to tmux's send-keys syntax; literal strings pass through as-is.
- `runWorkflow(steps)`: writes a workflow state file under the fixture's `stateBase`, then mounts the agent slot for each step via the `Runner` parameter on `HarnessStep`. Resolves when the run reaches terminal state or a configured pause predicate matches.
- Discovery of left/right pane IDs via `tmux.listPanes` after `initOrchSession` returns; expose them as the fixture's `left` and `right` handles.

**Patterns to follow.**
- `stripAnsi` re-exported from `src/observability/index.ts`.
- `tmux.capturePane`, `tmux.sendKeys`, `tmux.listPanes`: `src/services/tmux/real-tmux-service.ts`.
- Workflow + agent injection pattern: existing real-CLI tests use `respawnPane` with a runner script — generalize so the script is parameterized by the agent slot.

**Test scenarios.**
- `capture()` returns ANSI-stripped text; given a pane displaying styled output, the returned string contains the visible words but no escape sequences (`\x1b[`).
- `captureRaw()` returns the raw buffer with escape sequences intact.
- `waitForText('first thinking', { timeoutMs: 500 })` resolves before timeout when the text becomes visible; rejects with an error containing the last frame when it does not.
- `waitFor((text) => text.split('\n').length >= 3)` resolves when the predicate first holds true.
- `sendKeys('Enter')` results in tmux receiving the `Enter` named-key argv; `sendKeys('hello')` sends literal characters; `sendKeys('F')` sends an uppercase `F` (matches the keymap for follow-live).
- `runWorkflow` with two steps, where step 1's `FakeRunner` emits two transcript events and step 2 is unreached: returns `{ completed: false }` only if a pause predicate matched; otherwise runs to terminal state and returns `{ completed: true }`.
- `runWorkflow` propagates the agent slot — passing a `FakeRunner` results in `FakeRunner.invocationCount === 1` per step; the workflow driver never instantiates an agent of its own.

**Verification.** Harness self-tests pass. A scratch Tier 1 test (added in U3) can write `await fixture.runWorkflow([...]); await fixture.right.waitForText('expected output')` without further helpers.

---

### U3. Tier 1 starter set — visible-pane regression coverage

**Goal.** Add the Tier 1 starter tests against the harness, covering each named bug class. These are the canonical examples downstream agents and developers will read first.

**Requirements.** R9 (starter scenarios), R1 (Tier 1 scope), R2 (no duplication across tiers).

**Dependencies.** U1, U2.

**Files.**
- `tests/integration/hosts/two-pane/tier-1/autonomous-live-pane-shows-content.real.integration.test.ts`
- `tests/integration/hosts/two-pane/tier-1/replay-shows-same-transcript-as-live.real.integration.test.ts`
- `tests/integration/hosts/two-pane/tier-1/follow-live-returns-to-running-step.real.integration.test.ts`
- `tests/integration/hosts/two-pane/tier-1/interactive-pane-shows-prompt.real.integration.test.ts`
- `tests/integration/hosts/two-pane/tier-1/replay-revisit-reuses-pane.real.integration.test.ts`
- `tests/integration/hosts/two-pane/tier-1/banner-info-and-error-ttl.real.integration.test.ts`
- `tests/integration/hosts/two-pane/tier-1/view-mode-footer-reflects-mode.real.integration.test.ts`

**Approach.**
- Each test boots a `createRealTmuxFixture()`, scripts a `FakeRunner` for the relevant scenario, calls `runWorkflow(...)`, drives keypresses, and asserts on `right.capture()` / `left.capture()` / `waitForText`.
- The "warm cache" invariant in `replay-revisit-reuses-pane` is observed via pane-id stability between revisits (`tmux.listPanes` count and ids do not change), not via `recordedCalls`.
- Banner TTL assertions use `fixture.clock.advance(ms)` if exposed; otherwise drive real time bounded by the TTL constant in `src/hosts/two-pane/steps-view/banner.ts` — choice deferred to implementation, but the test asserts visible banner appearance and disappearance, not internal timer state.

**Patterns to follow.**
- `FakeRunner.script({ events, structuredOutput })`: `src/runners/fake/fake-runner.ts`.
- Existing scenario as a starting point: the `autonomous-live-pane-shows-content-immediately.integration.test.ts` mocked variant — rewrite at the visible-pane layer.

**Test scenarios.** *Note: these tests **are** the scenarios. Each file contains one focused scenario from R9. Specific assertions per file:*
- **autonomous-live-pane-shows-content** — Covers AE1 (partial). Given a single autonomous step whose `FakeRunner` emits "first thinking" / "second thinking", `right.waitForText('first thinking', { timeoutMs: 3000 })` resolves before timeout; `right.capture()` contains both lines and does not contain caret-notation echo bytes (`^M`, `^J`).
- **replay-shows-same-transcript-as-live** — Covers AE1. After the workflow completes, sending `Enter` on the completed step results in `right.capture()` containing the same two transcript lines that were visible during live.
- **follow-live-returns-to-running-step** — Covers AE2. With one running step and one completed step on the same run, opening the past step's replay then pressing `F` for follow-live results in `right.capture()` no longer containing the past step's transcript and `waitForText` on the running step's expected output resolves before timeout.
- **interactive-pane-shows-prompt** — One interactive (PTY) step. `right.waitForText('<prompt sentinel from FakeRunner>', { timeoutMs: 3000 })` resolves before timeout.
- **replay-revisit-reuses-pane** — Opens replay on a completed step, navigates away, re-opens replay; the right-pane `PaneId` is unchanged across the two opens (asserted via `tmux.listPanes`), demonstrating warm-cache reuse without touching `recordedCalls`.
- **banner-info-and-error-ttl** — Info-level banner appears (`left.waitForText('<banner text>')`) for a transient signal and clears within its TTL (`waitFor` predicate: banner text absent); error-level banner persists past the info TTL and only clears after an explicit dismiss keypress.
- **view-mode-footer-reflects-mode** — `left.capture()` contains `▶ live` while live; after `Enter` on a step, `left.waitForText('▶ replay')` resolves; the step name is rendered in the footer.

**Verification.** All seven tests pass with real tmux on PATH. All auto-skip cleanly when tmux is absent. No file references `FakeTmuxService.recordedCalls`.

---

### U4. Tier 2 projection starter set — Ink view tests

**Goal.** Add Tier 2 projection tests for view-mode footer transitions, key→intent mapping, banner rendering, end-of-run footer, and empty-steps state. Pure `<StepsView>` render against a fixture `StepsViewState` — no tmux.

**Requirements.** R10 (Tier 2 starter scenarios), R1 (Tier 2 scope).

**Dependencies.** None (independent of harness). Can land in parallel with U1-U2.

**Files.**
- `tests/unit/hosts/two-pane/steps-view/view-mode-footer.test.tsx`
- `tests/unit/hosts/two-pane/steps-view/key-intent-mapping.test.tsx`
- `tests/unit/hosts/two-pane/steps-view/banner-rendering.test.tsx` *(may extend existing `steps-view-banner.test.tsx` if scope overlaps — decide during audit U5)*
- `tests/unit/hosts/two-pane/steps-view/end-of-run-footer.test.tsx`
- `tests/unit/hosts/two-pane/steps-view/empty-steps-state.test.tsx`

**Approach.**
- Use `ink-testing-library`'s `render()` for keypress-driving tests and `renderToString` for synchronous frame snapshots.
- Fixtures are typed `StepsViewState` literals — small, hand-written, one per scenario. Avoid sharing fixtures across tests (per CLAUDE.md rule 4: no hidden shared state).
- Key→intent assertions wire `onIntent` to a recorder; each published key triggers exactly one expected intent payload.
- `renderToString` output passes through `stripAnsi` before substring assertions.

**Patterns to follow.**
- Existing `ink-testing-library` usage in `tests/unit/hosts/two-pane/steps-view/steps-view.test.tsx` and `selection.test.tsx`.
- `StepsViewState` discriminated union: `src/hosts/two-pane/steps-view/step-types.ts`.
- `StepsViewIntent` union: `src/hosts/two-pane/steps-view/steps-view.tsx`.

**Test scenarios.**
- **view-mode-footer** — Given `view: { mode: 'live' }`, rendered frame contains `▶ live`; given `view: { mode: 'replay', step: '<id>' }`, frame contains `▶ replay` and the step name; switching state and re-rendering updates the footer.
- **key-intent-mapping** — Each of `Up`, `Down`, `Enter`, `F`, `?`, `q`, `Esc` produces the expected `StepsViewIntent` payload exactly once when sent via `stdin.write`. Unmapped keys produce no intent. Holding `q` during a `confirming-quit` state triggers the published confirmation flow (no intent leakage).
- **banner-rendering** — Info banner with kind `:run-paused` renders the expected text and styling marker; error banner with kind `:agent-error` renders the error text and persists across re-renders until `dismiss-banner` intent fires; no banner field → no banner row in the frame.
- **end-of-run-footer** — For each terminal `status` (`completed`, `failed`, `crashed`), the footer text and color marker match the expected end-of-run row; pre-terminal states render the live footer instead.
- **empty-steps-state** — Given `steps: []`, the frame renders the empty-state copy and the footer; no step rows are present; pressing `Enter` produces no intent (no row to act on).

**Verification.** All Tier 2 tests pass without `tmux`. None of the tests instantiate `RealTmuxService` or `FakeTmuxService`. Each test names a single scenario sentence-style.

---

### U5. Audit pass — write canonical audit document with per-file dispositions

**Goal.** Produce a single audit doc at `docs/plans/2026-05-12-002-feat-tiered-testing-strategy-two-pane-audit.md` listing every file under `tests/unit/hosts/two-pane/**` (21 files) and `tests/integration/hosts/two-pane/**` (19 files) with one of three dispositions and a one-line justification keyed to a tier and bug class.

**Requirements.** R7 (audit every file), R8 (apply triage rule uniformly).

**Dependencies.** None — can run in parallel with U1-U4, since the audit is read-only research. Sequenced after U1-U4 in this plan so dispositions can reference the newly landed Tier 1 / Tier 2 starter scenarios as the "covered by higher tier" justification.

**Files.**
- `docs/plans/2026-05-12-002-feat-tiered-testing-strategy-two-pane-audit.md` (new doc, sibling to this plan)

**Approach.**
- The audit doc opens with the triage rule (R8 primary criterion verbatim plus tier definitions from R1).
- Each file gets one row: path, disposition (Keep / Rewrite / Delete), tier the disposition belongs to, target bug class, justification (one line).
- Special tagging in the doc: any test currently mocking `src/{core,state,validators,runners}` (banned per CLAUDE.md) is flagged for mandatory Rewrite or Delete, never Keep.
- The audit references the Tier 1 (U3) and Tier 2 (U4) tests by file path when justifying a Delete or a Rewrite-to-Tier-N.
- This unit produces the **document only**. Applying dispositions (deletions and rewrites) is U6.

**Patterns to follow.** None — this is a one-time analytical artifact.

**Test scenarios.** *Test expectation: none — this unit produces a markdown document, not behavior. Verification is rubric-based (see Verification). The audit doc itself encodes AE4 (Covers AE4) — any existing test that asserts only on `tmux.recordedCalls` shape with no visible-pane outcome must be classified Rewrite or Delete by U5; U6 applies the disposition.*

**Verification.**
- Every file under `tests/unit/hosts/two-pane/**` and `tests/integration/hosts/two-pane/**` appears in the audit table with a disposition and one-line justification.
- Every Rewrite / Delete cites the tier and bug class that supersedes it; every Keep names the bug class it uniquely protects.
- No file is flagged Keep if its sole assertion shape is `recordedCalls`-based and a higher tier covers the same scenario (AE4).
- The triage rule preamble matches R8 verbatim and lists the four tier definitions from R1.

---

### U6. Apply audit dispositions — delete, rewrite, and tag

**Goal.** Execute the audit produced in U5. Delete tests dispositioned Delete; rewrite tests dispositioned Rewrite so they assert on visible-pane outcome or projection; add a `// triage: keep|rewrite — <reason>` header comment to every kept and rewritten file.

**Requirements.** R7 (apply dispositions), R8 (uniform application).

**Dependencies.** U3, U4, U5. (U3/U4 must land first so Rewrite targets exist and Delete-because-covered-by-higher-tier is real.)

**Files.** Determined by the U5 audit; expected scope is ~30-40 files under `tests/{unit,integration}/hosts/two-pane/**`. Specific files listed in the audit doc, not pre-declared here per the brainstorm's "audit produces dispositions, not a percentage target" decision.

**Approach.**
- Process dispositions in batches by directory (`pane-map/`, top-level integration files, etc.) to keep `bun run check` runs scoped and bisectable.
- Deletes: `git rm <path>`.
- Rewrites: replace `recordedCalls`-shape assertions with the corresponding visible-pane assertion via the U1-U2 harness (for the integration tier) or with `renderToString` + `StepsViewState` fixture (for the unit tier). The triage comment names the new tier and the originating bug class.
- After each batch, run `bun run check` and commit.

**Patterns to follow.**
- Harness usage patterns established in U3 (Tier 1 examples).
- Ink projection patterns established in U4 (Tier 2 examples).

**Test scenarios.** *Test expectation: none — this unit modifies and deletes tests rather than introducing new behavior. Verification is `bun run check` green after each batch plus per-file disposition compliance.*

**Verification.**
- After all dispositions applied, `bun run check` is green.
- Every kept and rewritten file under `tests/{unit,integration}/hosts/two-pane/**` has a `// triage: keep|rewrite — <reason>` header comment matching its U5 audit row.
- No file marked Delete still exists in the repo.
- A spot-check on three Rewrite files confirms each replaces `recordedCalls`-shape assertions with visible-pane or projection assertions, not with new mocked-service assertions.

---

### U7. Tier 4 starter set + existing E2E migration

**Goal.** Add the two Tier 4 starter tests (one autonomous multi-step, one mixed-with-interactive) parameterized through the same harness with a real-CLI agent slot, gated by `RUN_REAL_TMUX_E2E=1` + `Bun.which('claude'|'codex')`. Migrate `tests/e2e/resume-real-claude.test.ts` and `tests/e2e/steps-tui-e2e.test.ts` onto the harness so the e2e directory holds one canonical test shape.

**Requirements.** R5 (agent-agnostic harness), R6 (env gate), R11 (Tier 4 starter scope), R12 (migrate existing e2e).

**Dependencies.** U1, U2, U3 (the Tier 1 starter establishes the test body shape that Tier 4 reuses).

**Files.**
- `tests/e2e/tier-4/autonomous-multi-step.real.e2e.test.ts` (new)
- `tests/e2e/tier-4/mixed-with-interactive.real.e2e.test.ts` (new)
- `tests/e2e/resume-real-claude.test.ts` (migrate — replace bespoke setup with `createRealTmuxFixture` + real `ClaudeRunner` agent slot)
- `tests/e2e/steps-tui-e2e.test.ts` (migrate — same shape)
- `package.json` (extend `scripts.test:e2e` to include `RUN_REAL_TMUX_E2E=1` when a `test:e2e:tmux` script is added; preserve existing `RUN_REAL_E2E=1` semantics for non-tmux e2e)
- `tests/helpers/real-tmux/index.ts` (export a `canRunRealTmuxE2E()` helper if not already exposed in U1)

**Approach.**
- Each Tier 4 test body imports `createRealTmuxFixture` and the real `ClaudeRunner` / `CodexRunner`. The test passes the real runner into `runWorkflow(steps[].agent)` — every other line of the test body is identical to the corresponding Tier 1 test.
- Migration tests reuse the harness's pane handles and `waitForText` instead of `wait(N)` + `capturePane` directly.
- Gate per test: `describe.skipIf(!canRunRealTmuxE2E())` where `canRunRealTmuxE2E()` checks `Bun.which('tmux')`, the matching CLI binary, and `process.env.RUN_REAL_TMUX_E2E === '1'`.

**Patterns to follow.**
- Real-runner instantiation: `src/runners/claude/index.ts`, `src/runners/codex/index.ts`.
- Existing `tests/e2e/resume-real-claude.test.ts` as the migration source — its scenario semantics are preserved; the setup/teardown is replaced.

**Test scenarios.**
- **autonomous-multi-step (Tier 4)** — Covers AE3. Given `RUN_REAL_TMUX_E2E=1` and `claude` on PATH, a workflow with two real-CLI autonomous steps runs to completion; `right.capture()` after the first step contains the live transcript text; after `Enter` on the second step, `right.waitForText('<second-step output>')` resolves before timeout. Given `RUN_REAL_TMUX_E2E` unset, the test auto-skips and the suite reports skipped, not failed.
- **mixed-with-interactive (Tier 4)** — One autonomous step plus one interactive (PTY) step. The interactive prompt appears in `right.capture()`; `sendKeys('<expected response>')` advances the step; the autonomous step's transcript is preserved when navigated back.
- **resume-real-claude (migrated)** — All assertions previously made about the run resuming via real `claude` are preserved; the test body now uses `fixture.right.waitForText(...)` instead of `wait(N)` + `capturePane`.
- **steps-tui-e2e (migrated)** — All assertions previously made about the steps-TUI startup, transitions, and shutdown are preserved; the test body uses the harness's `left` handle.
- **gating behavior** — Covers AE5. On a machine without `tmux` on PATH, all four files auto-skip; with `tmux` available but `RUN_REAL_TMUX_E2E` unset, all four files auto-skip; with both available, all four run.

**Verification.**
- `RUN_REAL_TMUX_E2E=1 bun test tests/e2e` is green on a machine with `claude` / `codex` available.
- Default `bun run check` reports the Tier 4 tests as skipped, not failed, on a CI machine without the env flag.
- The migrated `resume-real-claude.test.ts` and `steps-tui-e2e.test.ts` no longer call `tmux.capturePane` or `wait(N)` directly — all such calls go through harness handles.

---

### U8. Documentation — testing strategy and harness usage

**Goal.** Document the four-tier model, the triage rule, and the harness usage so future contributors and downstream agents (ce-plan, ce-work) reach for the right pattern without re-deriving conventions.

**Requirements.** Implicit success criterion from origin: *"A downstream agent (ce-plan or human implementer) reading this doc plus the harness API can write a new Tier 1 test for a new pane-map behavior without inventing new conventions."*

**Dependencies.** U1-U7 (docs reflect the as-implemented shape, not a speculative one).

**Files.**
- `docs/testing-strategy.md` (new) — four-tier model, triage rule, when to write at which tier, link to harness usage.
- `tests/helpers/real-tmux/README.md` (new) — harness API surface, example Tier 1 test skeleton, example Tier 4 promotion, gating rules.
- `CLAUDE.md` — add a `## How to write a two-pane test` subsection under "How to write tests" linking to `docs/testing-strategy.md` (≤ 5 lines added).
- `docs/solutions/two-pane-tiered-testing.md` (new, if `ce-compound` doesn't author it later) — one-line learnings about the shift from `recordedCalls` to visible-pane assertions and what triggered it.

**Approach.**
- `docs/testing-strategy.md` is the canonical reference; the harness README and `CLAUDE.md` link to it rather than restating.
- Include a short worked example in `docs/testing-strategy.md`: "to add a regression for a new right-pane bug, write a Tier 1 test that..." (5-line skeleton).
- Triage rule text in the testing-strategy doc matches R8 verbatim.

**Patterns to follow.**
- Doc style: existing `docs/logging.md`, `docs/getting-started.md`.
- Solutions doc shape: existing files under `docs/solutions/`.

**Test scenarios.** *Test expectation: none — this unit produces documentation. Verification is rubric-based (see Verification).* 

**Verification.**
- `docs/testing-strategy.md` defines all four tiers, the triage rule, and links to the harness README.
- `tests/helpers/real-tmux/README.md` shows a working Tier 1 example that compiles against the harness barrel.
- `CLAUDE.md` "How to write tests" section references the new doc.
- A reader can answer "where does my new test go?" without consulting source code.

---

## System-Wide Impact

- **`tests/{unit,integration}/hosts/two-pane/**`** — ~40 files audited; expected ~30-50% rewritten or deleted (exact number determined by U5). Net file-count likely decreases; assertion shape changes substantially. CI runtime impact: Tier 1 adds real-tmux boot to ~7 starter tests (each adds ~1-2s wall time when tmux is present); other rewrites may decrease total runtime by removing redundant mocked variants.
- **`tests/e2e/`** — two files migrated, two new Tier 4 files added. Default `bun run check` behavior unchanged (Tier 4 auto-skips). Adds one new env-gated run path for developers and (future) CI.
- **`tests/helpers/`** — gains a `real-tmux/` subdirectory; flat helpers untouched.
- **`src/**`** — **no source changes expected.** This plan is a test-surface refactor plus new test infrastructure. If the harness reveals an actual production bug during U3, that fix is out of this plan's scope and lands as a separate change.
- **`docs/**`** — new `docs/testing-strategy.md`, new audit doc, optional new solutions doc. Existing docs unchanged except a small `CLAUDE.md` addendum.
- **`package.json`** — possible `scripts.test:e2e:tmux` addition if convenient; existing `test`, `test:e2e`, `check` scripts unchanged in semantics.

---

## Risk Analysis & Mitigation

- **Tier 1 flakes from real-tmux timing.** Real-tmux tests on slow CI runners may hit `waitForText` timeouts on the happy path. *Mitigation:* harness `waitForText` default timeout (3000ms) is generous; tests use `waitForText` rather than fixed `wait(N)` so they pass as soon as the predicate holds. If flakes appear in U3, retune the per-test timeout, not the harness default. If flakes persist, demote the scenario to Tier 4 (env-gated) rather than weakening the assertion shape.

- **Audit scope creep.** The audit could expand into a generalized "rewrite everything" exercise. *Mitigation:* triage rule is fixed (R8 primary criterion); dispositions are per-file, not per-line. Tests outside `tests/{unit,integration}/hosts/two-pane/**` are explicitly out of scope (brainstorm R7). Tier 3 argv tests at the tmux seam are out of audit scope.

- **Harness API drift across U3 starter scenarios.** Each Tier 1 scenario might pull the API toward a slightly different shape, producing a kitchen-sink interface. *Mitigation:* land U1 + U2 with the smallest workable surface before any U3 test. New API methods land only when at least two Tier 1 tests need them; otherwise the test reaches into `fixture.host` directly with a one-off helper inside the test file.

- **Disposition disagreement between audit author and reviewers.** "Keep vs. Rewrite vs. Delete" is judgment-laden; the audit could stall on contested rows. *Mitigation:* the triage rule's primary criterion (R8) is the tiebreaker — if the test still passes when the visible pane is empty/wrong/unformatted, demote or delete. Contested rows default to Rewrite unless a Tier 1/2 test already provably covers them.

- **Tier 4 silent breakage between local runs.** Without a scheduled CI job, Tier 4 regressions surface only when a developer happens to run with the env flag. *Mitigation:* documented but deferred — `docs/testing-strategy.md` calls out the "developer-opt-in only" status and lists nightly CI as a follow-up. Acceptable v1 risk because Tier 4 is a backstop, not the primary gate.

- **Hidden coupling between rewritten tests and unmigrated tests.** Rewrites in U6 could accidentally remove a setup helper that another file still imports. *Mitigation:* batch rewrites by directory and run `bun run check` after each batch; `tsc --noEmit` will catch dangling imports immediately.

- **Nested-tmux fail-fast surprise.** A developer running tests inside an existing tmux session will hit the U1 guard and see a clear error, but might mistake it for a tmux availability failure. *Mitigation:* the error message names `TMUX` explicitly and instructs to run from outside tmux; mentioned in the harness README.

---

## Verification Strategy

- `bun run check` is green after each unit lands.
- Tier 1 tests fail before the corresponding production fix and pass after — verified by reproducing one historical right-pane bug (e.g., the doubling bug) as a U3 test, asserting the test would have caught it.
- The audit doc U5 covers every file under `tests/{unit,integration}/hosts/two-pane/**` with a disposition; spot-check three Rewrite results in U6 against the triage rule.
- Tier 4 tests skip cleanly without the env flag and run successfully with it (smoke-verified on a developer machine).
- After U8 docs land, a reviewer reads `docs/testing-strategy.md` plus `tests/helpers/real-tmux/README.md` and writes a new Tier 1 test in under 20 minutes without consulting source code.

---

## Scope Boundaries

### In scope
- New harness module at `tests/helpers/real-tmux/`.
- Tier 1/2 starter coverage per R9-R10.
- Tier 4 starter (2 tests) per R11.
- Audit + per-file dispositions across `tests/{unit,integration}/hosts/two-pane/**` (~40 files).
- Migration of `tests/e2e/resume-real-claude.test.ts` and `tests/e2e/steps-tui-e2e.test.ts` per R12.
- Documentation per U8.

### Outside this product's identity (carried from origin)
- Adopting `microsoft/tui-test`, `charmbracelet/vhs`, or any external TUI framework as a dependency.
- Visual / ANSI-byte / color-rendering regression tests.
- Snapshot / golden-file recording (`.tape`-style).
- Expanding the new approach to test surfaces outside `src/hosts/two-pane/**` (runners, workflow core, validators, etc.).
- Performance / load testing of the tmux layer.
- Migrating off `bun:test` or introducing a different test runner.
- Rewriting `RealTmuxService` argv-shape tests at the tmux seam (they are Tier 3 and stay).
- Tier 4 coverage parity with Tier 1.

### Deferred to Follow-Up Work
- **Dedicated CI job for Tier 4** (nightly or per-PR-with-label). v1 ships developer-opt-in only; CI cadence decision deferred until U3/U7 reveal Tier 4 signal-vs-noise on real CLIs.
- **Rollup pane assertion hooks.** If a future Tier 1 scenario requires direct rollup-pane assertions, extend the harness then.
- **`docs/solutions/two-pane-tiered-testing.md`** if not authored as part of U8 — can be deferred to a `ce-compound` follow-up after a real regression is caught at Tier 1 (the canonical example for the solutions doc).
- **Audit rule refinements** discovered during U6 application that would change earlier dispositions — captured as audit doc updates, not in-flight rework.

---

## Dependencies / Assumptions

- `tmux` available on developer machines (and on whatever CI runners run integration tests). Today this matches reality — existing `*.real.integration.test.ts` files already depend on it.
- `FakeRunner` is sufficient to express the agent side of every Tier 1 scenario in R9. The brainstorm's existing pane-map and host code already supports it; no new fake-runner capabilities required.
- The current `TmuxService` port and `RealTmuxService` argv shape are stable — the harness wraps them and does not require host changes to be useful.
- The audit is implementable as a one-time pass on ~40 files, not as a long-running background task.
- `process.env.TMUX` is reliably set by tmux when a shell runs inside a tmux session — used as the nested-tmux guard in U1.

---

## Documentation Plan

Covered by U8. Specifically:
- `docs/testing-strategy.md` — canonical reference for the four-tier model and the triage rule.
- `tests/helpers/real-tmux/README.md` — harness API and worked example.
- `CLAUDE.md` — short pointer to `docs/testing-strategy.md` under "How to write tests".
- Optional `docs/solutions/two-pane-tiered-testing.md` — institutional learning (may defer to `ce-compound`).

---

## Operational / Rollout Notes

- The plan lands incrementally — each unit is one commit (or one batch within U6). No long-lived feature branch.
- No production code changes expected; rollout risk is bounded to the test suite.
- Tier 4 is opt-in from day one. No coordination needed with CI infra; the `RUN_REAL_TMUX_E2E=1` flag is local-developer driven until a follow-up adds a scheduled job.
- After U6 commits, the test suite is the gate — anyone running `bun run check` immediately benefits from the new shape; no migration window or shim period.
