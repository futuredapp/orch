# Acceptance Tests — cmux Integration

> High-level **behavioral acceptance criteria** for the `CmuxHost` cmux integration, derived from
> [2026-06-04-cmux-integration-brainstorm.md](2026-06-04-cmux-integration-brainstorm.md). Each is meant to become
> a real, executing test. They describe behavior, not implementation — read them to know the feature works without
> reading the code. Track implementation by AT-ID in the status table below.
>
> Phase 2 tests (AT-13 through AT-16) are research-gated. A planning pass should confirm the hook-routing
> mechanism and event-type additions needed before implementing those tests.

---

## Tests

### AT-1 — First step start sets all four sidebar pills with step position

- **Given** orch is running inside cmux (`CMUX_SURFACE_ID` is set), a workflow with three steps (e.g. "plan", "review", "build") has been launched, and no cmux pills are active yet
- **When** the first step ("plan") begins executing
- **Then** the cmux sidebar receives four pills: one for the workflow name, one for the step name that includes its position in the sequence (e.g. "plan · 1/3"), one for the active runner (e.g. "claude"), and one for the mode (e.g. "autonomous") — all four arrive before the step completes
- **Observable through** a full orch run with `CmuxHost` wired alongside the real workflow executor and a `FakeProcessService`; assert four `cmux set-status` (or equivalent) invocations in the process service call history, and verify the step pill's payload includes the position counter "1/3"

---

### AT-2 — Step transition refreshes the step and mode pills in place, not accumulating

- **Given** a three-step workflow has started in cmux, the first step ("plan", autonomous) has begun and the four sidebar pills were set (AT-1 precondition)
- **When** "plan" completes and the second step ("review", interactive) starts
- **Then** the step pill is updated to show the new step name and position (e.g. "review · 2/3") and the mode pill is updated (e.g. "interactive"); the total pill count stays at four — no additional pills accumulate — and the pill keys for step and mode are the same stable keys reused from step 1
- **Observable through** same run as AT-1 continued through the second `step:start` lifecycle event; assert the pill key used for the step pill in the second `set-status` call matches the key from the first, the step count stays at four, and the position counter reads "2/3"

---

### AT-3 — An interactive step start fires a "needs you" notification

- **Given** orch is running inside cmux and the workflow contains a step defined with `mode: 'interactive'` (the step carries `mode: 'interactive'` in the `step:start` lifecycle event)
- **When** that interactive step's `step:start` event is received by `CmuxHost`
- **Then** a cmux notification fires naming that step as needing the operator's attention; no such notification fires for autonomous steps
- **Observable through** a full orch run with a mixed workflow (one autonomous step, one interactive step) and `FakeRunner`; assert a `cmux notify` invocation appears for the interactive step and does not appear for the autonomous step in the process service call history

---

### AT-4 — Successful run fires a completion notification with duration and workflow name

- **Given** orch is running inside cmux and all steps complete successfully
- **When** the run settles as completed
- **Then** a cmux notification fires that includes the workflow name and the total run duration; it fires after the last step completes and before orch exits
- **Observable through** the `orch run` CLI entry point with `CmuxHost` wired via composite; assert the `cmux notify` invocation in the process service call history after the run settles

---

### AT-5 — Failed run fires a failure notification with the failing step name and workflow name

- **Given** orch is running inside cmux and one step exits with a non-zero code
- **When** the run settles as failed
- **Then** a cmux notification fires that includes the workflow name and the name of the step that failed; it fires after the failing step and before orch exits
- **Observable through** same entry point as AT-4 with a `FakeRunner` configured to fail one step; assert the `cmux notify` invocation carries the expected step name

---

### AT-6 — All sidebar pills are cleared when the run ends successfully

- **Given** an orch run in cmux that created the four sidebar pills
- **When** the run completes successfully
- **Then** every pill the integration created is cleared via the cmux CLI — no stale pills remain in the sidebar after orch exits
- **Observable through** same entry point as AT-4; assert that `cmux clear-status` (or equivalent) invocations for all four pill keys appear in the process service call history after the run ends

---

### AT-7 — All sidebar pills are cleared when the run ends with a failure

- **Given** an orch run in cmux that created the four sidebar pills
- **When** the run ends because a step failed
- **Then** every pill the integration created is cleared via the cmux CLI — no stale pills remain in the sidebar after orch exits
- **Observable through** same entry point as AT-5; assert that `cmux clear-status` (or equivalent) invocations for all four pill keys appear in the process service call history after the failed run ends

---

### AT-8 — CMUX_SURFACE_ID absent means zero cmux CLI invocations for the entire run

- **Given** `CMUX_SURFACE_ID` is not set in the environment, and `CmuxHost` is still composed (wired in the composition root)
- **When** a full orch run executes from start to finish
- **Then** no cmux CLI invocations are made at any point during the run; the run's outcome is identical to running with the integration absent
- **Observable through** a full orch run with `CmuxHost` wired + `FakeProcessService`; assert zero calls where `argv[0] === 'cmux'`; assert the run completes with the expected outcome

---

### AT-9 — cmux unavailable at startup disables the integration for the entire run

- **Given** `CMUX_SURFACE_ID` is set, but the cmux socket is unreachable (the availability probe at startup fails or returns a non-zero exit)
- **When** a full orch run executes
- **Then** no cmux CLI invocations are made beyond the initial availability probe; the run proceeds and completes normally with no errors propagated from the failed probe
- **Observable through** `FakeProcessService` returning a non-zero exit for the cmux probe; assert no further cmux argv calls and that the run outcome is unaffected

---

### AT-10 — A cmux CLI failure mid-run is swallowed and does not affect the step or run

- **Given** orch is running inside cmux with pills set, and a cmux CLI call fails mid-step (non-zero exit)
- **When** the failed cmux call happens during a step's execution
- **Then** the step completes normally, subsequent steps proceed, and the final run outcome is the same as it would have been with no cmux failure
- **Observable through** `FakeProcessService` returning exitCode 1 on a cmux spawn during a step; assert that the step and run complete with the same outcome as the zero-failure case

---

### AT-11 — Config switch disables the integration even when CMUX_SURFACE_ID is set

- **Given** `CMUX_SURFACE_ID` is set, and the cmux integration is explicitly disabled via the orch configuration switch
- **When** a full orch run executes
- **Then** no cmux CLI invocations are made; the run proceeds and completes identically to running with the integration absent
- **Observable through** full orch run with the config switch set; assert zero `cmux`-argv calls in the `FakeProcessService` call history

---

### AT-12 — Notification identifies the specific workflow, distinguishing it from other concurrent runs

- **Given** two separate `runWorkflow()` invocations have been executed with different workflow names ("lint-fix" and "code-review"), each with its own `CmuxHost` instance and `FakeProcessService`
- **When** each run completes
- **Then** each completion notification carries its own workflow name — "lint-fix" for the first run and "code-review" for the second — and does not include the other run's name
- **Observable through** two sequential `runWorkflow()` calls (or parallel, each with its own `FakeProcessService`) with distinct workflow names; assert the `cmux notify` invocation for each run carries that run's workflow name and nothing from the other run

---

### AT-13 — Claude runner emits a normalized awaiting-input event when the agent is blocked on input *(Phase 2)*

- **Given** a claude step is executing and the claude agent reaches a point where it is waiting for human input (e.g. a permission prompt)
- **When** the agent enters that waiting state
- **Then** a normalized `awaiting-input` event is emitted on the Host seam — observable by any `Host` consumer — before the wait resolves
- **Observable through** `ClaudeRunner` running against a scenario that triggers the agent's input-wait hook, with a `FakeHost` recording all events; filter the recorded events for an `awaiting-input` type

---

### AT-14 — Codex runner emits a normalized awaiting-input event when the agent is blocked on input *(Phase 2)*

- **Given** a codex step is executing and the codex agent reaches a point where it is waiting for human input
- **When** the agent enters that waiting state
- **Then** a normalized `awaiting-input` event is emitted on the Host seam before the wait resolves
- **Observable through** `CodexRunner` in the same setup as AT-13; assert the same event shape in `FakeHost`'s recording

---

### AT-15 — The awaiting-input event contains no cmux-specific content *(Phase 2)*

- **Given** either the Claude or Codex runner emits an `awaiting-input` event
- **When** the event is received by any Host consumer
- **Then** the event payload contains only runner-agnostic fields (e.g. step name, agent name, run context); it contains no cmux surface IDs, pill keys, or cmux-format fields
- **Observable through** the `FakeHost` recorded event payload for the `awaiting-input` event; assert the absence of any cmux-namespaced fields

---

### AT-16 — CmuxHost fires an agent-blocked notification when it receives an awaiting-input event *(Phase 2)*

- **Given** orch is running inside cmux and a runner emits an `awaiting-input` event on the Host seam
- **When** `CmuxHost` processes that event
- **Then** a cmux notification fires that names the blocked run and the waiting agent; it fires before the agent's wait resolves
- **Observable through** `CmuxHost` receiving an `awaiting-input` event via its `Host` interface (e.g. via `onRunnerEvent` carrying the event), with `FakeProcessService` observing the resulting `cmux notify` invocation

---

## Status

| ID    | Behavior                                                     | Status   | Test file | Notes                          |
| ----- | ------------------------------------------------------------ | -------- | --------- | ------------------------------ |
| AT-1  | First step sets all four sidebar pills                       | ⬜ todo  |           |                                |
| AT-2  | Step transition refreshes pills in place, no accumulation    | ⬜ todo  |           |                                |
| AT-3  | Interactive step start fires "needs you" notification        | ⬜ todo  |           |                                |
| AT-4  | Successful run fires completion notification with duration   | ⬜ todo  |           | Requires composition-root hook |
| AT-5  | Failed run fires failure notification with step name         | ⬜ todo  |           | Requires composition-root hook |
| AT-6  | Pills cleared on successful run end                          | ⬜ todo  |           |                                |
| AT-7  | Pills cleared on failed run end                              | ⬜ todo  |           |                                |
| AT-8  | CMUX_SURFACE_ID absent → zero cmux invocations               | ⬜ todo  |           |                                |
| AT-9  | cmux unavailable at startup → zero subsequent cmux calls     | ⬜ todo  |           | Probe mechanism TBD in planning|
| AT-10 | cmux CLI failure mid-run is swallowed                        | ⬜ todo  |           |                                |
| AT-11 | Config switch disables integration regardless of env var     | ⬜ todo  |           | Config switch form TBD in planning |
| AT-12 | Notification identifies the specific workflow                | ⬜ todo  |           |                                |
| AT-13 | Claude runner emits awaiting-input event *(Phase 2)*         | ⬜ todo  |           | Research-gated; runner hook TBD|
| AT-14 | Codex runner emits awaiting-input event *(Phase 2)*          | ⬜ todo  |           | Research-gated; runner hook TBD|
| AT-15 | awaiting-input event has no cmux content *(Phase 2)*         | ⬜ todo  |           | Depends on AT-13/AT-14         |
| AT-16 | CmuxHost translates awaiting-input to notification *(Phase 2)* | ⬜ todo |           | Depends on AT-13/AT-14         |

Legend: ⬜ todo · ✅ implemented · 🚫 won't implement (reason in Notes)

---

## Feasibility appendix

The **Driving surface** is what triggers the behavior in the test (prefer the real entry point — launch a run via the CLI handler or `runWorkflow()`); the **Observation surface** is where the result is read (prefer the true external boundary — `FakeProcessService` call history for cmux CLI side-effects, run outcome for correctness). These two columns replace a bare "tier" verdict on purpose: naming both forces the altitude decision and exposes any test that would drive an inner seam instead of the real entry point.

All Phase 1 tests belong in the **mocked-integration** category (real `CmuxHost` + real `runWorkflow()` + `FakeRunner` + `FakeProcessService`). They must drive `runWorkflow()` (or the composition-root handler for AT-4, AT-5, AT-6, AT-7 to catch unwired run-end hooks) rather than calling `cmuxHost.onLifecycleEvent()` directly — direct poking would pass even if `CmuxHost` is never composed with the real executor.

| ID    | Testable today | Driving surface | Observation surface | Gap & suggested change |
| ----- | -------------- | --------------- | ------------------- | ---------------------- |
| AT-1  | yes            | `runWorkflow()` + `CmuxHost` wired via composite, `FakeRunner`, `FakeProcessService` | `FakeProcessService` call history: `cmux set-status` invocations | None — `FakeProcessService` tracks all spawns by argv |
| AT-2  | yes            | Same as AT-1, two-step workflow | `FakeProcessService` call history: pill key reuse and call count between two step:start events | None |
| AT-3  | yes            | `runWorkflow()` with an interactive-mode step, `FakeRunner` (interactive path still emits `step:start` with `mode: 'interactive'`) | `FakeProcessService` call history: `cmux notify` before step:complete | None |
| AT-4  | partial        | Composition-root run handler (e.g. `executeWithAttach` or equivalent finally-block wrapper), not bare `runWorkflow()` | `FakeProcessService` call history: `cmux notify` after run settles | **Composition-root hook required**: `run-ended` is not delivered to the Host seam (R13); the `orch run` CLI handler must call `cmuxHost.notifyRunEnd()` (or similar) in its finally block. Test must drive that handler, not bare `runWorkflow()`, or a bare-`runWorkflow()` test would pass even if the composition hook were never wired. |
| AT-5  | partial        | Same as AT-4, `FakeRunner` configured to fail one step | `FakeProcessService` call history: `cmux notify` with failing step name | Same composition-root hook gap as AT-4 |
| AT-6  | partial        | Same as AT-4 | `FakeProcessService` call history: `cmux clear-status` for all pill keys after run end | Same composition-root hook gap; pill clearing must also go in the finally block |
| AT-7  | partial        | Same as AT-5 | Same as AT-6 | Same composition-root hook gap |
| AT-8  | yes            | `runWorkflow()` + `CmuxHost` wired, `CMUX_SURFACE_ID` unset in test env | `FakeProcessService` spy: assert zero calls where `argv[0] === 'cmux'`; assert run outcome matches reference run | None — `FakeProcessService` throws on any unscripted spawn, making stray cmux calls fail the test naturally |
| AT-9  | partial        | `runWorkflow()` + `CmuxHost` wired, `CMUX_SURFACE_ID` set, `FakeProcessService` returning error on cmux probe argv | `FakeProcessService` call history: one failed probe call, then zero further cmux calls; assert run completes normally | **Probe mechanism unspecified**: planning must decide whether CmuxHost probes availability via a fast cmux invocation, an env check, or socket probe. Test cannot be written until the probe argv is known; add as a planning prerequisite. |
| AT-10 | yes            | `runWorkflow()` + `CmuxHost` wired, `FakeProcessService` returning exitCode 1 on a cmux call during a step | Run outcome matches the no-cmux-failure baseline; no exception escapes the Host boundary | None — `FakeProcessService` can return any exit code; CmuxHost must wrap spawns in try/catch |
| AT-11 | partial        | `runWorkflow()` + `CmuxHost` wired, config switch set, `CMUX_SURFACE_ID` set | Zero cmux-argv calls; run outcome unaffected | **Config switch form TBD**: planning must define the config field (e.g. `cmux.enabled: false` in `OrchestratorConfig`, or env var `ORCH_CMUX_DISABLED`). The test cannot be written until the switch's shape is in the config schema. |
| AT-12 | yes            | Two separate `runWorkflow()` invocations with different workflow names, each with `CmuxHost` wired | `FakeProcessService` call history: each `cmux notify` invocation carries the respective workflow name | None |
| AT-13 | no             | `ClaudeRunner` in a real tmux pane (or via the gated `full-host:real-agent` driver) reaching an input-wait scenario | `FakeHost` recorded events: filter for `awaiting-input` type before wait resolves | **Runner enhancement required**: `ClaudeRunner` must inject a hook (e.g. `--settings` Notification/Stop hook) that calls back into orch. A new `awaiting-input` type must be added to the `RunnerEvent` union. Depends on Phase 2 research into how cmux's own claude wrapper routes hooks. |
| AT-14 | no             | `CodexRunner` reaching an input-wait scenario | Same as AT-13 | Same gap; Codex uses a different hook mechanism (`notify` program/config). Research needed per Outstanding Questions. |
| AT-15 | no             | AT-13 or AT-14 scenario once runners can emit the event | Recorded `RunnerEvent` payload: assert absence of cmux-namespaced fields | Depends on AT-13 / AT-14 |
| AT-16 | no             | `onRunnerEvent` called on a real `CmuxHost` with an `awaiting-input` `RunnerEvent`, `FakeProcessService` observing the result | `FakeProcessService` call history: `cmux notify` with run + agent identity | Depends on the `RunnerEvent` type addition from AT-13/AT-14. Once the event type exists, AT-16 is a straightforward unit test of `CmuxHost.onRunnerEvent`. |
