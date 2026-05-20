---
date: 2026-05-12
topic: tiered-testing-strategy-two-pane
---

# Tiered Testing Strategy for the Two-Pane Host

## Summary

A four-tier testing model for orch's two-pane / tmux surfaces, with a reusable real-tmux harness that lets tests assert on visible-pane content rather than file-existence or recorded-call proxies, an explicit triage rule for auditing existing two-pane tests, and an agent-agnostic harness shape so the same Tier 1 flows can run against `FakeRunner` in CI or a real `claude` / `codex` runner in env-gated E2E.

---

## Problem Frame

Right-pane bugs ship despite green tests. Recently observed and partially documented in commit history: right pane empty after `step:start`; right pane unformatted; right pane not switched after step transitions; follow-live landing on the wrong source; replay opening the wrong content. The diagnose loop today is "see it live during an interactive run → describe the symptom to the agent → fix and ship." There is no automated regression net for visible-pane behavior.

The cost shape: most of the two-pane test surface — `tests/unit/hosts/two-pane/pane-map/*`, several files under `tests/integration/hosts/two-pane/*` — asserts on `FakeTmuxService.recordedCalls` (e.g., `splits.length === 1`, argv shapes, lifecycle event records). These verify the FakeTmuxService received the right poke; they cannot fail when the *visible pane* is empty, unformatted, or showing the wrong content. The two most recent regression tests landed alongside the recent right-pane fix (`autonomous-live-pane-shows-content-immediately`, `right-pane-live-doubling.real.integration`) had to fall back to file-existence and tee-byte proxies because the harness for "actually inspect the visible pane" is one-off — only `tests/integration/hosts/two-pane/end-of-run.real.integration.test.ts` boots a real tmux server and `capturePane`s the result, and there is no reusable helper.

When tests pass green despite visible-pane breakage, the implementation-detail tests become a *source* of risk, not just low value — they generate false confidence and create churn on every refactor without catching the bug class that ships.

---

## Requirements

**Tier definitions**

- R1. Define four test tiers covering two-pane behavior, each scoped to a specific bug class:
  - **Tier 1 — Real-tmux behavioral.** Real tmux server, real services, `FakeRunner` agents. Asserts on visible-pane content and on observable view state (view-mode, banner, focus) after running a workflow and/or driving keypresses. Catches: empty pane, wrong source, mis-formatted output, follow-live regressions, replay routing.
  - **Tier 2 — Ink projection.** No tmux. `renderToString` of `<StepsView>` against a fixture `StepsViewState`, optionally driving keypresses through `ink-testing-library`. Catches: state→view bugs, key→intent mapping, view-mode footer correctness, banner rendering.
  - **Tier 3 — Argv contract.** `RealTmuxService` composed with `FakeProcessService`. Asserts on the exact argv sent to tmux (flag ordering, `-d` on swap-pane, `-c` on respawn, etc.). Catches: tmux contract violations before they reach a real tmux server.
  - **Tier 4 — Real-tmux + real-runner E2E.** Same harness as Tier 1, with `claude` / `codex` agents instead of `FakeRunner`. Env-gated and runtime-gated. Catches: real-CLI argv escaping, env propagation, PTY behavior in interactive mode, multi-step flows under real conditions.

- R2. Each tier has a unique responsibility. A test belongs to exactly one tier; tests do not duplicate coverage across tiers except where the same flow is exercised at Tier 1 (fake agent, CI) and Tier 4 (real agent, env-gated) as the canonical "mocked + real" pair.

**Real-tmux harness**

- R3. Provide a reusable real-tmux harness usable by Tier 1 and Tier 4. Capabilities the harness must expose at the test surface:
  - Boot an isolated tmux server on a per-test socket; tear it down on test exit.
  - Mount a real `TmuxHost` against real services (fs, state, logger) and a configurable agent slot per step.
  - Capture the visible left and right pane contents as text (ANSI-stripped by default).
  - Send keys to the attached session (single keys, named keys like `Enter`, `Up`, `Down`, `F`).
  - Wait for a text predicate on left or right pane to become true, with a bounded timeout.
  - Run a workflow to completion or to a specified pause point.
- R4. The harness auto-skips when `tmux` is not on `PATH`, following the existing `Bun.which('tmux')` convention.
- R5. The harness is agent-agnostic: the agent for each step is a parameter, not baked into the harness. Tier 1 passes `fakeAgent({...})`; Tier 4 passes a real-CLI agent. The flow expressed by the test body is identical between the two.
- R6. Tier 4 runs are gated by both `Bun.which('claude'|'codex')` *and* an env flag (e.g., `RUN_REAL_TMUX_E2E=1`). They do not run on every push.

**Audit triage rule**

- R7. Audit every test file under `tests/unit/hosts/two-pane/**` and `tests/integration/hosts/two-pane/**` against a written triage rule. Each test gets one of three dispositions:
  - **Keep** — encodes a behavior that no higher tier covers and that protects against a real bug class. Includes Tier 3 argv-shape tests on the tmux seam.
  - **Rewrite** — the behavior under test is real, but the assertion shape is implementation-detail. Rewrite to assert on the visible-pane outcome or the projection.
  - **Delete** — the test re-states implementation detail and the behavior is now (or will be) covered at a higher tier.
- R8. The triage rule is articulated as concrete criteria in the brainstorm-derived plan and applied uniformly. The primary criterion: "Would this test still pass if the visible pane were empty / wrong / unformatted? If yes, demote or delete."

**Coverage starter set**

- R9. Tier 1 ships with a starter set covering the named bug classes (not exhaustive parity with existing pane-map unit tests):
  - Autonomous step `step:start` → visible right pane shows non-empty content within a bounded window.
  - Autonomous step `step:complete` → opening replay on the completed step shows the same transcript text the live pane showed.
  - Follow-live (`f` keypress) after visiting a past replay → right pane swaps back to the running step's source.
  - Interactive (PTY) step `step:start` → right pane shows the interactive prompt text within a bounded window.
  - Replay revisits do not respawn the underlying pane (warm-cache invariant) — observable via timing or pane lifecycle, not via `recordedCalls`.
  - Banner state: info-level banner appears for transient signals and clears within its TTL; error-level banner persists until dismissed.
  - View-mode footer reflects current mode (`▶ live` vs `▶ replay · <step>`).

- R10. Tier 2 ships projection coverage for: view-mode footer transitions, key → intent mapping for the published keymap (`Up`, `Down`, `Enter`, `F`, `?`, `q`, `Esc`), banner rendering at each kind/state, end-of-run footer for terminal-state runs, empty-steps state.

- R11. Tier 4 starts narrow: one autonomous-only multi-step flow, one mixed flow that includes at least one interactive step. Both reuse the Tier 1 harness surface, swapping the agent.

**Existing E2E migration**

- R12. `tests/e2e/resume-real-claude.test.ts` and `tests/e2e/steps-tui-e2e.test.ts` migrate onto the new harness. After migration, there is one canonical shape for "real-tmux test," parameterized by agent and gating flags.

---

## Acceptance Examples

- AE1. **Covers R3, R9.** Given a workflow with one autonomous step whose fake agent emits two transcript events ("first thinking", "second thinking"), when the harness runs the workflow to completion and the test sends `Enter` to open replay on that step, then `right.waitForText('first thinking')` resolves before timeout and `right.capture()` contains both transcript lines and does not contain caret-notation echo bytes.

- AE2. **Covers R3, R9.** Given a workflow with one autonomous step still running and a previously-completed step on the same run, when the test opens the past step's replay (`Enter`) and then presses `F` for follow-live, then `right.capture()` no longer contains the past step's transcript and `right.waitForText` on the running step's expected output resolves before timeout.

- AE3. **Covers R3, R5, R11.** Given the same Tier 1 test body parameterized with a real-CLI agent and `RUN_REAL_TMUX_E2E=1`, when the test runs with `claude` on PATH, then it executes against the real CLI and asserts the same visible-pane outcomes. When `RUN_REAL_TMUX_E2E` is unset, the test auto-skips.

- AE4. **Covers R7, R8.** Given an existing test that asserts `tmux.recordedCalls.filter(c => c.method === 'splitPane')).toHaveLength(1)` and nothing else about visible-pane outcome, when the audit applies the triage rule, then the test is classified Rewrite (replace with a Tier 1 behavioral assertion) or Delete (if a Tier 1 test for the same scenario already exists).

- AE5. **Covers R4, R6.** Given a developer machine without `tmux` on PATH, when the test suite runs, then all Tier 1 and Tier 4 tests auto-skip and the suite reports skipped, not failed. Given a CI environment with `tmux` available but `RUN_REAL_TMUX_E2E` unset, only Tier 1 runs.

---

## Success Criteria

- A right-pane bug surfaced during an interactive orch run can be reproduced as a Tier 1 test that fails before the fix and passes after, with the test asserting on visible-pane text. The agent reaches for this pattern when writing regression tests, not for `recordedCalls` proxies.
- The two-pane test surface as a whole no longer has tests that pass green when the visible pane is empty / wrong / unformatted. Every such bug class has at least one tier that catches it.
- After the audit, every kept test under `tests/unit/hosts/two-pane/**` and `tests/integration/hosts/two-pane/**` is referenced by its disposition decision (Keep / Rewrite / Delete) with a one-line justification keyed to a tier and a bug class.
- A downstream agent (ce-plan or human implementer) reading this doc plus the harness API can write a new Tier 1 test for a new pane-map behavior without inventing new conventions.

---

## Scope Boundaries

- Adopting `microsoft/tui-test`, `charmbracelet/vhs`, or any external TUI test framework as a dependency. The harness is in-tree, matching the project's existing fakes-injected-via-constructor idiom.
- Visual / ANSI-byte / color-rendering regression tests. Assertions are on text content after ANSI strip.
- Snapshot / golden-file recording (`.tape`-style). Useful for demos and onboarding, not for invariant tests.
- Expanding the new approach to test surfaces outside `src/hosts/two-pane/**`. Runners, workflow core, validators, etc. keep their existing coverage shape; the audit does not touch them.
- Performance / load testing of the tmux layer.
- Migrating off `bun:test` or introducing a different test runner.
- Rewriting `RealTmuxService` argv-shape tests at the tmux seam. They are Tier 3 and stay.
- Tier 4 coverage parity with Tier 1. Tier 4 is two starter tests; broader real-CLI coverage stays out.

---

## Key Decisions

- **Four tiers, not three.** The user explicitly raised the gap between "real-tmux + fake runner" and "real-tmux + real runner"; the harness is designed agent-agnostic so the same Tier 1 flow can be promoted to Tier 4 by swapping the agent. Tier 4 closes the multi-step real-CLI flow gap that today is covered only thinly by the two existing files in `tests/e2e/`.
- **In-tree harness, not `microsoft/tui-test`.** Lower dependency surface; matches the project's existing fake-services-via-constructor pattern; the existing `end-of-run.real.integration.test.ts` already implements ~80% of the primitives — generalizing it costs less than adopting and adapting an external framework.
- **Auto-skip on `Bun.which('tmux')`, no new env flag for Tier 1.** Matches the project's existing convention. Tier 4 adds an env flag because real-CLI runs are slower and have external dependencies; Tier 1 is fast enough to run on every push when tmux is present.
- **Audit produces explicit per-test dispositions, not a percentage target.** Per-file delete/rewrite/keep with justification keyed to a tier and bug class, applied uniformly via the triage rule. Avoids the trap of "delete 30% of tests" as a quantitative goal that does not match what each test is actually for.
- **Text-content assertions only; no ANSI/color regression.** The named bug class is visible-content bugs ("empty," "wrong," "unformatted as text"), not color/style regression. Color regression is a different bug class with a different fix.
- **Tier 1 covers a starter set, not parity.** The named bug classes get coverage first. Broader parity with existing implementation-detail tests is the audit's job (delete or rewrite), not a coverage-expansion deliverable.

---

## Dependencies / Assumptions

- `tmux` available on developer machines and CI runners for Tier 1. Today this matches reality (the existing `end-of-run.real.integration.test.ts` and several other real-tmux tests already depend on it).
- `FakeRunner` is sufficient to express the agent-side of every Tier 1 scenario. The existing pane-map and host code already supports it.
- The current `RealTmuxService` and `TmuxHost` interfaces are stable enough to wrap; the harness does not require host changes to be useful.
- The audit will be implementable as a one-time pass on ~30–40 test files under the two-pane subtree, not as a long-running background task.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R3][Technical] Exact shape of the harness API (method names, return types, ergonomics around `waitFor` timeouts and predicates). Decide during plan-time using existing helpers as the starting point.
- [Affects R3, R9][Technical] How the harness handles parallel-branch flows (rollup pane lifecycle) — the existing pane-map design has a hidden rollup pane; whether the harness exposes assertion hooks on it or treats it as part of the "right pane source" abstraction.
- [Affects R7][Technical] Whether the audit produces a single AUDIT.md document or per-file annotations in the test files themselves.
- [Affects R6][Needs research] Whether CI runs a dedicated job for Tier 4 (e.g., nightly) or leaves it purely developer-machine-opt-in. Affects how often Tier 4 regressions surface.
- [Affects R10][Technical] Whether Tier 2 projection tests live in their existing locations under `tests/unit/hosts/two-pane/steps-view/**` or get a new top-level grouping.
