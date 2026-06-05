# Acceptance Tests — cmux Integration

> High-level **behavioral acceptance criteria** for the cmux integration, derived from
> [2026-06-04-cmux-integration-brainstorm.md](./2026-06-04-cmux-integration-brainstorm.md).
> Each is meant to become a real, executing test. They describe behavior, not
> implementation — read them to know the feature works without reading the code.
> Track implementation by AT-ID in the status table below.
>
> Scope note: AT-1 … AT-12 cover **Phase 1** (direct orch↔cmux integration, R1–R6,
> R10–R16). AT-13 … AT-14 cover **Phase 2** (agent awaiting-input hooks, R7–R9) and
> are **research-gated** — see the feasibility appendix.
>
> Surface note: orch talks to cmux exclusively by running the cmux CLI through
> `ProcessService` (R3). That `ProcessService` edge is the **public boundary to cmux** —
> the tests observe cmux behavior there (which cmux CLI calls were made, with what
> identity), the same way a caller would. Asserting at that edge is *not* an
> implementation assertion; it is the contract between orch and cmux.
>
> Intentionally not acceptance-tested: the **architecture-shape** requirements —
> R1 (composite host, not a registry/event-bus), R2 (all cmux code in one module), and
> R8's "no cmux-specific code in the runners" rule — are structural constraints, not
> user-observable behavior. They are enforced by code review and `bun run check`
> (CLAUDE.md rules), not by an AT. Their *behavioral* consequences are covered:
> R8's reusable-event consequence is AT-14; R1/R2 have no behavioral consequence.

## Tests

### AT-1 — While a run is active inside cmux, the sidebar reflects workflow, step (N/M), runner, and mode

- **Given** orch is running inside cmux (`CMUX_SURFACE_ID` present) and a workflow with multiple steps begins
- **When** the first step starts
- **Then** cmux is told to show the current workflow name, the current step with its `N/M` position, the active runner (e.g. claude), and the mode (interactive/autonomous)

### AT-2 — Step and mode pills update in place on each transition rather than accumulating

- **Given** a run inside cmux has set its pills for step 1 of N
- **When** the run advances through subsequent steps
- **Then** the sidebar shows exactly one step pill and one mode pill at all times, each reflecting the *current* step — earlier steps' pills are replaced, not stacked alongside

### AT-3 — Every pill the integration created is cleared when the run ends

- **Given** a run inside cmux created status pills
- **When** the run reaches a terminal outcome where orch's own run-end / teardown path still executes — each of: completed, failed, and a thrown error caught by the composition root (hard SIGKILL is explicitly excluded — there is nowhere to run cleanup)
- **Then** for every one of those terminal outcomes, every pill the integration created is cleared, leaving no stale pill behind — and a cmux clear call that itself fails is swallowed (it must not crash teardown or leave the run in error)

### AT-4 — An interactive step starting fires a "needs you" notification naming that step

- **Given** orch is running inside cmux
- **When** a step whose mode is `interactive` starts
- **Then** a cmux notification fires that names that step as needing the operator

### AT-5 — A run with no interactive steps fires no "needs you" notification

- **Given** orch is running inside cmux and the workflow contains only autonomous steps
- **When** the run executes start to finish
- **Then** no "needs you" / interactive-step notification is fired at any point

### AT-6 — A successful run fires a completion notification carrying the run duration

- **Given** orch is running inside cmux and a workflow runs to successful completion
- **When** the run settles
- **Then** a cmux notification fires reporting success and carrying a single human-readable elapsed duration measured from run start to settle (e.g. `4m12s`) — not a raw start/end timestamp pair the operator must subtract

### AT-7 — A failed run fires a failure notification naming the failing step

- **Given** orch is running inside cmux and a workflow fails at a particular step
- **When** the run settles as failed
- **Then** a cmux notification fires reporting failure and naming the step that failed

### AT-8 — Run notifications identify their own workflow so parallel runs are distinguishable

- **Given** two orch runs are active in two different cmux workspaces
- **When** one of them completes
- **Then** that run's completion notification carries the identity (workflow name) of *that* run, not the other

### AT-9 — With no cmux present, a full run makes zero cmux CLI invocations and behaves identically

- **Given** `CMUX_SURFACE_ID` is unset
- **When** a workflow executes start to finish
- **Then** zero cmux CLI invocations are made for the entire run, and the run's observable behavior is identical to running with the integration absent

### AT-10 — With cmux's socket off or unreachable, the run makes zero cmux CLI invocations

- **Given** `CMUX_SURFACE_ID` is present but cmux is unavailable despite the env marker — covering both the configured `off` socket mode and a runtime-unreachable socket (both reduce to the same observable no-op)
- **When** a workflow executes start to finish
- **Then** detection resolves cmux as unavailable up front and zero cmux CLI invocations are made for the entire run

### AT-11 — A cmux CLI failure mid-run is swallowed and never affects the step or run

- **Given** orch is running inside cmux
- **When** a cmux CLI call (a pill update or a notification) fails mid-run — non-zero exit, or cmux was quit so the call errors
- **Then** the error is swallowed: the step that was running and the overall run complete exactly as they would have, and the failure does not surface as a step or run failure

### AT-12 — A configuration switch disables the integration even when running inside cmux

- **Given** orch is running inside cmux (`CMUX_SURFACE_ID` present) but the cmux integration is turned off via configuration
- **When** a workflow executes start to finish
- **Then** zero cmux CLI invocations are made for the entire run

### AT-13 — When the wrapped agent blocks on input, a notification names that agent as waiting *(Phase 2)*

- **Given** orch is running inside cmux and a claude/codex step is mid-execution
- **When** the wrapped agent reaches a point where it is waiting for human input (e.g. a permission prompt)
- **Then** a cmux notification fires that names the run and names the agent (claude/codex) as waiting for input

### AT-14 — Awaiting-input detection is cmux-agnostic: the signal is emitted for any observer, not only cmux *(Phase 2)*

- **Given** orch is running with the cmux integration absent or disabled, and a claude/codex step is mid-execution
- **When** the wrapped agent blocks on human input
- **Then** a normalized `awaiting-input` signal is still emitted on orch's host seam and is observed by a non-cmux host consumer (it is not contingent on cmux being present)

> Note: that detection *lives in the runner, free of cmux-specific code* (R8, CLAUDE.md rule #2) is a structural constraint enforced by review, not by this test. This AT only pins the observable consequence — the signal reaches a non-cmux observer.

## Status

| ID    | Behavior                                                  | Status  | Test file | Notes |
| ----- | --------------------------------------------------------- | ------- | --------- | ----- |
| AT-1  | Pills reflect workflow / step N/M / runner / mode         | ⬜ todo |           | Needs `stepIndex`/`stepTotal`/`workflowName` on lifecycle events (see appendix). |
| AT-2  | Step + mode pills update in place, not accumulate         | ⬜ todo |           | Keyed pills; observed via stable pill key at the cmux CLI edge. |
| AT-3  | All pills cleared on graceful terminal state              | ⬜ todo |           | Hard SIGKILL out of scope per product decision. |
| AT-4  | Interactive step start fires "needs you" notification     | ⬜ todo |           | `mode` already on `step:start`. |
| AT-5  | No interactive steps → no "needs you" notification        | ⬜ todo |           | Negative. |
| AT-6  | Successful run fires completion notify with duration      | ⬜ todo |           | Fired from composition root after run settles (R13). |
| AT-7  | Failed run fires failure notify naming failing step       | ⬜ todo |           | Fired from composition root after run settles (R13). |
| AT-8  | Notifications carry own-workflow identity                 | ⬜ todo |           | Disambiguates parallel runs in separate workspaces. |
| AT-9  | No `CMUX_SURFACE_ID` → zero cmux CLI calls, identical run  | ⬜ todo |           | Core not-in-cmux safety. |
| AT-10 | Socket off/unreachable → zero cmux CLI calls              | ⬜ todo |           | Needs a way to detect/simulate cmux socket availability. |
| AT-11 | cmux CLI failure mid-run swallowed                        | ⬜ todo |           | Covers both pill-update and notification calls. |
| AT-12 | Config switch disables integration inside cmux            | ⬜ todo |           | Needs config field threaded to the cmux host. |
| AT-13 | Agent awaiting-input → notification names agent           | ⬜ todo |           | **Phase 2**, research-gated (hook routing through tmux). |
| AT-14 | Awaiting-input signal is cmux-agnostic on host seam       | ⬜ todo |           | **Phase 2**, depends on AT-13's event existing. |

Legend: ⬜ todo · ✅ implemented · 🚫 won't implement (reason in Notes)

## Feasibility appendix

> The Phase 1 cmux behaviors are unit / mocked-integration tests against
> `FakeProcessService` (the mockable `ProcessService` edge — CLAUDE.md rule #1, #3),
> asserting which cmux CLI calls were made (or not). These land on the `bun run check`
> gate (lint + typecheck + unit + mocked-integration). Phase 2 detection is the
> research-gated unknown.
>
> This input is a **brainstorm**, not a plan: a planning/implementation pass should
> confirm the infrastructure below exists (or is built) so these tests are runnable.

| ID    | Testable today | Level / tier             | Gap & suggested change |
| ----- | -------------- | ------------------------ | ---------------------- |
| AT-1  | partial        | mocked-integration       | (1) `StepLifecycleEvent` `step:start` carries `mode` but **not** the step `N/M` index or the workflow name — add `stepIndex` / `stepTotal` / `workflowName` to the lifecycle events (or pass `workflowName` to the cmux host at construction; it is already on `WorkflowDeps.workflowName`). (2) Add a recorded-spawns surface to `FakeProcessService` (see AT-9) so the test can assert the pill calls' argv/identity. |
| AT-2  | partial        | mocked-integration       | Same event-shape + recorded-spawns gaps as AT-1. The "in place" assertion observes that pill updates reuse a **stable key** across transitions at the cmux CLI edge. |
| AT-3  | yes            | mocked-integration       | Needs the cmux host to track which pills it created and a run-end clearing path; observable via recorded cmux clear-status calls. No core gap once the cmux host exists. |
| AT-4  | yes            | mocked-integration       | `mode` is already on `step:start`. Needs the cmux host + recorded-spawns surface. |
| AT-5  | yes            | mocked-integration       | Negative of AT-4; same infra. |
| AT-6  | partial        | mocked-integration       | `run-ended` is not delivered to the host (R13) — needs a composition-root run-end hook (around `await trackedWorkflow` in `src/cli/commands/execute-with-attach.ts`) or a new `Host.onRunEnd(outcome, durationMs)` port method, plus a duration source. Recorded-spawns surface to assert the notify. |
| AT-7  | partial        | mocked-integration       | Same composition-root run-end hook as AT-6; failing-step identity must reach the hook. |
| AT-8  | yes            | mocked-integration       | `workflowName` is available to the executor (`WorkflowDeps.workflowName`) and `runId` to the host factory — thread to the cmux host. Recorded-spawns surface to assert identity in the notify argv. |
| AT-9  | partial        | mocked-integration       | **Key infra gap:** `FakeProcessService` today throws on an unqueued `spawn` rather than recording it, so there is no "assert zero invocations matching cmux argv" surface. Add a public recorded-spawns getter (argv/cwd/env per call) so a test can assert `recordedCmuxSpawns().length === 0`. This single change unblocks the assertion side of most cmux tests. |
| AT-10 | partial        | mocked-integration       | Needs (a) a defined notion of cmux socket availability that the host probes once up front, and (b) a fake/stub for that probe so a test can force "off/unreachable". The exact socket-mode detection is deferred to planning (brainstorm Outstanding Questions); the test asserts the resulting no-op via the recorded-spawns surface. |
| AT-11 | yes            | mocked-integration       | `FakeProcessService` can be scripted to return a non-zero exit (or throw) for the cmux argv; assert the step/run still complete normally. Needs the cmux host's swallow-and-continue error handling. |
| AT-12 | yes            | unit / mocked-integration | Needs a config field (e.g. on `orch.config.ts`) threaded to the cmux host constructor; test forces it off and asserts zero cmux calls via recorded-spawns. |
| AT-13 | no             | Tier 4 (real CLI) or fake-emitted event + mocked-integration | **Research-gated central unknown:** how a claude/codex "awaiting-input" hook callback reaches orch through the tmux wrapping layer (brainstorm Outstanding Questions — clone cmux to study its routing). Once a runner emits a normalized `awaiting-input` event, the cmux→notify translation is mocked-integration; proving real detection end-to-end needs a real CLI at Tier 4, or a fake runner taught to emit the event for the translation half. |
| AT-14 | no             | mocked-integration        | Depends on AT-13's normalized event existing on the host seam. Once it does, this is a host-seam observation with a second (non-cmux) host observer — no cmux infra needed, but blocked on the Phase 2 event. |
