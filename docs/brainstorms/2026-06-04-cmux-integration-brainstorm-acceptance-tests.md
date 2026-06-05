# Acceptance Tests — cmux Integration

> High-level **behavioral acceptance criteria** for the cmux integration, derived from
> [2026-06-04-cmux-integration-brainstorm.md](./2026-06-04-cmux-integration-brainstorm.md).
> Each is meant to become a real, executing test. They describe behavior, not
> implementation — read them to know the feature works without reading the code. Track
> implementation by AT-ID in the status table below.
>
> **Planning-pass note (this input is a brainstorm, not a plan).** A planning/implementation
> pass must confirm the infrastructure to *run* these tests exists. The feasibility appendix
> records the gaps; the load-bearing ones are: a **recorded-spawns surface** on
> `FakeProcessService` (to assert on / count cmux-CLI argv, including *zero* calls), a
> **composite/fan-out host** plus the `CmuxHost` itself, a **composition-root run-end hook
> with run duration** (run-end is not delivered through the `Host` port), **workflow/runner
> identity** reaching the cmux layer (absent from lifecycle events today), and — Phase 2 —
> a **normalized `awaiting-input` event** on the host seam. The tests are the target; the
> plan must make them runnable.
>
> Phase tags below mirror the brainstorm: **Phase 1** = direct orch↔cmux integration
> (AT-1…AT-12); **Phase 2** = agent awaiting-input hooks (AT-13, AT-14), research-gated.

## Tests

### AT-1 — Pills reflect workflow / step / runner / mode while a run is active *(Phase 1)*

- **Given** orch is running inside cmux and a workflow with named steps is executing
- **When** a step is active
- **Then** the cmux sidebar carries pills identifying the current workflow, the current step and its position in the run, the active runner (e.g. claude/codex), and the mode (interactive/autonomous)
- **Observable through** a real workflow run driven through the executor + the cmux-CLI argv boundary (the `set-status` invocations seen at `ProcessService`)

### AT-2 — Step and mode pills update in place across transitions, not accumulate *(Phase 1)*

- **Given** orch is running inside cmux and a multi-step workflow advances from one step to the next
- **When** the next step starts
- **Then** the step and mode pills are replaced in place (the operator sees one current step/mode, not a growing list of every step that ran)
- **Observable through** a real multi-step workflow run through the executor + the keyed cmux `set-status` argv (same pill key reused, not appended) at `ProcessService`

### AT-3 — Every pill the integration created is cleared when the run ends *(Phase 1)*

- **Given** a run inside cmux created sidebar pills
- **When** the run reaches any terminal state — completed, failed, or crashed
- **Then** every pill the integration created is cleared (no stale pills survive the run)
- **Observable through** a full run taken to a terminal state via the composition root + the cmux `clear-status` argv at `ProcessService`

### AT-4 — An interactive step start fires a "needs you" notification *(Phase 1)*

- **Given** orch is running inside cmux and a workflow contains a step with `mode: 'interactive'`
- **When** that interactive step starts
- **Then** a cmux notification fires naming that step as needing the operator
- **Observable through** a real workflow run (with one in   teractive step) through the executor + the cmux `notify` argv at `ProcessService`

### AT-5 — A run with no interactive steps fires no "needs you" notification *(Phase 1)*

- **Given** orch is running inside cmux and a workflow whose every step is autonomous
- **When** the run executes start to finish
- **Then** no "needs you" notification is fired for any step
- **Observable through** a real all-autonomous workflow run through the executor + the absence of any "needs you" `notify` argv at `ProcessService`

### AT-6 — A successful run fires a completion notification including a duration *(Phase 1)*

- **Given** orch is running inside cmux and a workflow runs to successful completion
- **When** the run settles successfully
- **Then** a cmux notification fires reporting completion and including how long the run took
- **Observable through** a full run through the composition root (where the run settles) + the cmux `notify` argv carrying the duration at `ProcessService`

### AT-7 — A failed run fires a failure notification naming the failing step *(Phase 1)*

- **Given** orch is running inside cmux and a workflow in which a step fails
- **When** the run settles as failed
- **Then** a cmux notification fires reporting failure and naming the step that failed
- **Observable through** a full run with a failing step through the composition root + the cmux `notify` argv naming the step at `ProcessService`

### AT-8 — Notifications carry own-workflow identity for parallel-run disambiguation *(Phase 1)*

- **Given** orch is running inside cmux (where an operator may have several runs active in different workspaces)
- **When** a run fires any notification (completion, failure, or "needs you")
- **Then** the notification identifies *that specific run's* workflow, enough for the operator to tell which run fired it
- **Observable through** a run through the composition root + the workflow identity carried on the cmux `notify` argv at `ProcessService`

### AT-9 — With `CMUX_SURFACE_ID` unset, a full run makes zero cmux CLI calls and behaves identically *(Phase 1)*

- **Given** orch starts with `CMUX_SURFACE_ID` absent from the environment
- **When** a full workflow run executes start to finish
- **Then** zero cmux CLI invocations are made and the run's observable outcome is identical to running with the integration absent
- **Observable through** a full run + the cmux-CLI argv boundary at `ProcessService` (asserting no cmux invocation was ever spawned)

### AT-10 — With the cmux socket off or unreachable, a full run makes zero cmux CLI calls *(Phase 1)*

- **Given** orch starts inside cmux but the cmux socket mode is `off` (or the socket is unreachable) at startup detection
- **When** a full workflow run executes start to finish
- **Then** zero cmux CLI invocations are made for the life of the run
- **Observable through** a full run + the cmux-CLI argv boundary at `ProcessService` (asserting no cmux invocation was ever spawned)

### AT-11 — A cmux CLI failure mid-run is swallowed and never perturbs the run *(Phase 1)*

- **Given** orch is running inside cmux and a run is in progress
- **When** a cmux CLI call fails mid-run (non-zero exit, or cmux was quit and the socket is gone)
- **Then** the error is swallowed: the current step and the overall run complete with the same outcome they would have had with no cmux integration
- **Observable through** a real run through the executor with the cmux spawn scripted to fail at `ProcessService` + the run/step outcome (the step still completes, the run still settles to its normal result)

### AT-12 — A configuration switch disables the integration even inside cmux *(Phase 1)*

- **Given** orch is running inside cmux (`CMUX_SURFACE_ID` present) but the cmux integration is disabled by configuration
- **When** a full workflow run executes start to finish
- **Then** zero cmux CLI invocations are made for the life of the run
- **Observable through** a full run through the composition root with the disable config set + the cmux-CLI argv boundary at `ProcessService` (asserting no cmux invocation was ever spawned)

### AT-13 — Agent awaiting-input fires a notification naming the waiting agent *(Phase 2 — research-gated)*

- **Given** orch is running inside cmux and a claude/codex step is mid-execution
- **When** the wrapped agent blocks waiting for human input (e.g. a permission prompt)
- **Then** a cmux notification fires naming the run and the agent that is waiting
- **Observable through** a real claude/codex step run through the executor that reaches an awaiting-input state + the cmux `notify` argv naming the agent at `ProcessService`

### AT-14 — Awaiting-input is observable as a normalized, cmux-agnostic event on the host seam *(Phase 2 — research-gated)*

- **Given** orch is running a claude/codex step (cmux not required for this signal)
- **When** the wrapped agent blocks waiting for human input
- **Then** a normalized `awaiting-input` event — carrying no cmux-specific detail — is delivered on the `Host` lifecycle seam, where a non-cmux consumer can observe it
- **Observable through** a real claude/codex step run through the executor + the `Host` lifecycle seam as seen by a second, non-cmux host consumer. *(This `Observable through` deliberately names the host seam, not the cmux argv: R8 is precisely that the signal is reusable by a non-cmux consumer, so the seam is the honest outermost surface for this behavior — not a convenience choice. The driving surface is still a real run that makes the runner emit the event, so the test fails if the runner never wires it.)*

## Status

| ID    | Behavior                                                  | Status  | Test file | Notes |
| ----- | -------------------------------------------------------- | ------- | --------- | ----- |
| AT-1  | Pills reflect workflow / step / runner / mode           | ⬜ todo  |           | Phase 1. Step "position" (N/M) representation is an infra gap — see appendix. |
| AT-2  | Step + mode pills update in place                       | ⬜ todo  |           | Phase 1 |
| AT-3  | All pills cleared on terminal state                     | ⬜ todo  |           | Phase 1. Needs composition-root run-end hook. |
| AT-4  | Interactive step start fires "needs you" notification   | ⬜ todo  |           | Phase 1 |
| AT-5  | No interactive steps → no "needs you" notification      | ⬜ todo  |           | Phase 1 (negative) |
| AT-6  | Success notification with duration                      | ⬜ todo  |           | Phase 1. Needs run-end hook + run-duration computation. |
| AT-7  | Failure notification names failing step                 | ⬜ todo  |           | Phase 1. Needs run-end hook. |
| AT-8  | Notifications carry own-workflow identity               | ⬜ todo  |           | Phase 1. `workflowName` must reach the cmux layer. |
| AT-9  | No `CMUX_SURFACE_ID` → zero cmux calls, identical run   | ⬜ todo  |           | Phase 1 (safety). Needs recorded-spawns surface. |
| AT-10 | cmux socket off/unreachable → zero cmux calls           | ⬜ todo  |           | Phase 1 (safety). Needs recorded-spawns surface. |
| AT-11 | cmux CLI failure mid-run is swallowed                   | ⬜ todo  |           | Phase 1 (safety) |
| AT-12 | Config switch disables integration inside cmux          | ⬜ todo  |           | Phase 1. Needs `cmux` config field. |
| AT-13 | Awaiting-input fires notification naming the agent      | ⬜ todo  |           | Phase 2, research-gated |
| AT-14 | Awaiting-input is a cmux-agnostic event on host seam    | ⬜ todo  |           | Phase 2, research-gated. Observed at host seam by design (R8). |

Legend: ⬜ todo · ✅ implemented · 🚫 won't implement (reason in Notes)

## Feasibility appendix

The **Driving surface** is what triggers the behavior in the test (prefer the real entry
point — launch a real run through the executor or composition root, not a synthetic
lifecycle event poked at a port); the **Observation surface** is where the result is read
(prefer the true external boundary — the cmux-CLI argv as seen at `ProcessService`, or the
host seam for the one cmux-agnostic-signal behavior). These two columns replace a bare
"tier" verdict on purpose: naming both forces the altitude decision and exposes any test
that would drive an inner seam instead of the real entry point.

These ATs sit on the **three-layer model** (CLAUDE.md: unit / mocked-integration / e2e) at
the **executor + composition-root** level, with `FakeProcessService` as the cmux-CLI edge —
*not* the two-pane five-tier model, which governs the tmux host specifically and is
orthogonal here. None of AT-1…AT-14 needs on-screen (tmux/Ink) evidence; they assert at the
cmux-argv boundary or the host seam. Phase-1 ATs are intended to land on `bun run check`
(lint + typecheck + unit + mocked-integration). Phase-2 ATs (AT-13/AT-14) depend on the
research-gated hook-routing mechanism and are gated accordingly.

| ID    | Testable today | Driving surface | Observation surface | Gap & suggested change |
| ----- | -------------- | --------------- | ------------------- | ---------------------- |
| AT-1  | partial | Real workflow run via `executor.execute(deps)` with `CmuxHost` over `FakeProcessService` | cmux `set-status` argv at `ProcessService` | Build `CmuxHost` + composite host. Add **recorded-spawns surface** on `FakeProcessService`. `step:start` lacks `workflowName`/`runnerName` and **no step total exists** (workflows are imperative callbacks) — N/M position needs a design decision (running index vs. declared total). |
| AT-2  | partial | Multi-step `executor.execute` run | Ordered, keyed cmux `set-status` argv | Recorded-spawns surface; keyed-pill (replace-in-place) semantics are a `CmuxHost` design point. `mode` is already on `step:start`. |
| AT-3  | no | Full run to terminal state via composition root | cmux `clear-status` argv | Run-end is **not** on the `Host` port — needs a composition-root run-end hook into `CmuxHost`. Recorded-spawns surface. |
| AT-4  | partial | `executor.execute` with one `mode:'interactive'` step | cmux `notify` argv | Trigger data (`mode`) present today; only `CmuxHost` + recorded-spawns surface missing. |
| AT-5  | partial | `executor.execute`, all-autonomous workflow | absence of "needs you" `notify` argv | Recorded-spawns surface (for a clean absence assertion) + `CmuxHost`. |
| AT-6  | no | Full run through composition root (run settles in `executeWithAttach`) | cmux `notify` argv carrying duration | Run-end hook **and** run-duration is not computed today (stamp start→settle via `deps.clock`). Recorded-spawns surface. |
| AT-7  | no | Full run with a failing step through composition root | cmux `notify` argv naming the step | Run-end hook at root. Failing `stepName` is already available. Recorded-spawns surface. |
| AT-8  | no | Full run through composition root | workflow identity on cmux `notify` argv | `workflowName` lives on `WorkflowDeps`, not on events — inject into `CmuxHost` at construction. Recorded-spawns surface. |
| AT-9  | partial | Full run with `CMUX_SURFACE_ID` unset (host-factory / root level) | zero cmux argv at `ProcessService` | **Recorded-spawns surface is the crux** — today an un-scripted spawn *throws* rather than being recorded, so "zero calls" can only be asserted by side-effect. Plus `CmuxHost` no-op detection. |
| AT-10 | no | Full run with cmux socket mode `off`/unreachable | zero cmux argv | Recorded-spawns surface + a way to simulate "socket unreachable" at detection (scriptable probe via `ProcessService`). |
| AT-11 | partial | `executor.execute` with the cmux spawn scripted to fail (non-zero / throw) at `FakeProcessService` | step/run outcome unchanged (step completes, run settles normally) | `FakeProcessService` can already script a non-zero exit; `CmuxHost` swallow logic is the new code. |
| AT-12 | no | Full run through composition root with `CMUX_SURFACE_ID` set + cmux disabled in config | zero cmux argv | No `cmux` field in `OrchestratorConfig` / `ConfigSchema` (`src/config/index.ts`) yet — add `cmux?: { enabled?: boolean }`, read at the root alongside env detection. Recorded-spawns surface. |
| AT-13 | no | Real claude/codex step run reaching awaiting-input, via `executor.execute` | cmux `notify` argv naming the agent | Phase 2. Needs the normalized `awaiting-input` event **and** the research-gated runner hook routing through the tmux layer (brainstorm Outstanding Questions). Recorded-spawns surface. |
| AT-14 | no (but cleanest infra) | Real claude/codex step run reaching awaiting-input, via `executor.execute` | the `Host` lifecycle seam as seen by a second, non-cmux consumer (`FakeHost.recorded` records any lifecycle event generically — `tests/helpers/fake-host.ts`) | Phase 2. Needs the new normalized event variant on the seam; **observation infra already exists** — `FakeHost` records lifecycle events with no new harness. Hook routing is research-gated. |
