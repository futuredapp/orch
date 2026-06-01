---
date: 2026-06-01
topic: predictable-fake-agent
---

# Predictable Externally-Driven Fake Agent

## Summary

A predictable fake agent — built by extending the existing puppet mode — that orch can run in both headless and interactive modes, that a driver addresses per-instance via the step's cache key under the run's state dir, and that emits a readiness signal when it is idle-waiting for input. It lets high-level tests (and, later, an autonomous QA agent) drive a real workflow deterministically and assert on what the two-pane UI shows, without racing a real agent's variable timing.

---

## Problem Frame

Real coding-agent CLIs (Claude Code, Codex) are non-deterministic to test against: they vary in latency, occasionally error, and emit output on their own schedule. A behavioral or UI test that drives a real agent races the agent — the test may snapshot the pane before the agent has produced output, or after it has already advanced. The same races make an autonomous QA agent unreliable: a faster-or-slower agent under test produces flaky verdicts.

The cost shows up today as either avoided coverage (no high-level tests that exercise the two-pane host end-to-end against an agent) or flaky coverage (real-CLI Tier-4 tests gated behind env flags, run rarely). The project already has a related scar: leaked puppet daemons pile up and make the real-tmux suite ~8× slow and flaky (see `memory/real-tmux-suite-flakiness-root-cause.md`), so any new long-lived test process must tear down cleanly.

The existing fakes only partially cover the need. `FakeRunner` is in-process and pre-scripted at construction time. `ScriptedFakeRunner`'s puppet mode is externally drivable at runtime via an NDJSON control file, but only along the headless path — there is no interactive-TUI fake that blocks until externally fed input, and no readiness signal telling a driver the agent is actually waiting.

---

## Actors

- A1. Test author: writes a high-level real-tmux test, authors a workflow using the fake agent, and drives it via thin wrapper helpers.
- A2. Autonomous QA agent (future): launches or attaches to a run, addresses individual fake-agent instances, and drives them to verify orch behavior. Out of scope to build now; the addressing design must not preclude it.
- A3. Fake agent instance: one running step backed by the fake runner, in either headless or interactive mode.
- A4. orch core / two-pane host: spawns the fake per its mode, renders its output into the right pane, advances the workflow on `finish`, and surfaces lifecycle events.

---

## Key Flows

- F1. Drive a two-step workflow end-to-end
  - **Trigger:** A test launches a two-step workflow (step 1 interactive, step 2 headless) on the real-tmux harness.
  - **Actors:** A1, A3, A4
  - **Steps:**
    1. Workflow starts; step 1 (interactive fake) spawns and renders its TUI into the right pane.
    2. Driver waits for step 1's readiness signal, then snapshots — asserts step 1 selected, fake agent visible.
    3. Driver sends `finish` to step 1's instance and awaits the ack.
    4. Workflow advances; step 2 (headless fake) spawns; driver waits for its readiness signal.
    5. Driver sends `type_and_send "…"` lines (awaiting each ack), then snapshots — asserts the lines appear in the right pane.
    6. Driver sends `finish`; asserts the run reaches a finished state.
  - **Outcome:** The run completed deterministically; every assertion was made against a known-stable agent state.
  - **Covered by:** R1, R2, R3, R5, R7, R8, R10

- F2. Drive parallel instances without cross-talk
  - **Trigger:** A workflow runs `parallel([run(FAKE, { as: 'a' }), run(FAKE, { as: 'b' })])`, and/or a second workflow run executes concurrently.
  - **Actors:** A1, A3, A4
  - **Steps:**
    1. Driver obtains a handle for branch `a` and a handle for branch `b` (and, across runs, handles scoped to each `runId`).
    2. Driver sends `type_and_send "to-a"` to handle `a` and `type_and_send "to-b"` to handle `b`.
    3. Each command is delivered only to its target instance; acks confirm per-instance receipt.
  - **Outcome:** Branch `a` shows only `to-a`, branch `b` only `to-b`; a concurrent run's agents receive nothing from this run's driver.
  - **Covered by:** R6, R9, R11, R12

---

## Requirements

**Core engine and modes**
- R1. The fake agent SHALL share one input/command engine across both modes; the two modes differ only in how output reaches the right pane (headless = NDJSON events rendered by orch's transcript pipeline; interactive = the agent renders its own Ink TUI into the pane).
- R2. The command vocabulary SHALL be exactly `type_and_send` (append one line of agent output) and `finish` (end the step, with an optional exit/result code) for this version.
- R3. `type_and_send` and `finish` SHALL behave identically regardless of mode and regardless of input channel (control-file command vs. manual keystroke).

**Input channels and symmetry**
- R4. The engine SHALL accept commands from two channels that map to the same operations: an external control channel (the puppet NDJSON control file) and real manual stdin.
- R5. Manual input SHALL be parsed into the same vocabulary: a bare line of text is `type_and_send` of that text; the literal `q` or `exit` is `finish`.
- R6. Manual typing SHALL work in interactive (TUI) mode. (Manual typing in headless mode is out of scope — see Scope Boundaries.)

**Addressing and isolation**
- R7. Each running fake-agent instance SHALL be addressable by a logical address derived from the step's cache key (`deriveStepKey`: sub-path + `as:` label + vars), and its control transport SHALL live under that run's state dir (`.orch/state/<runId>/test-control/<key>.ndjson`).
- R8. A driver SHALL hold a per-instance handle (not just a shared pane handle) keyed by the same label/path the workflow author used, and the thin wrappers `typeAndSend(handle, text)` / `finish(handle, code?)` SHALL target that instance.
- R9. A parallel branch SHALL be individually addressable only when it carries a stable label (`as:`); this follows the existing cache-key + R20 collision-guard model. Unlabeled, identically-named parallel branches are a collision, consistent with current behavior.
- R10. The logical address (run + label-path) SHALL be kept separate from the transport (control file) so the transport can later change (e.g., socket/IPC) without changing how instances are addressed.
- R11. Two concurrent workflow runs SHALL be isolated: a driver targeting one run's instances cannot deliver to another run's instances. This is satisfied structurally by per-`runId` state dirs.

**Confirmation and readiness**
- R12. Each control-channel command SHALL produce a confirmation a driver can await (reuse puppet's existing per-sequence `.ack` mechanism). Acks are best-effort for manual keystrokes.
- R13. The fake agent SHALL emit a readiness signal when it has rendered and is idle-waiting for input, distinct from `step:start` (which fires at spawn). Drivers/tests use it to wait for "now waiting" before sending work or snapshotting.

**Lifecycle hygiene**
- R14. Every fake-agent instance SHALL tear down cleanly when its run ends or is torn down, leaving no leaked tailing/daemon processes (guarding against the documented real-tmux leaked-daemon flakiness).

---

## Acceptance Examples

- AE1. **Covers R3, R5.** Given a step running in either mode, when the driver sends `type_and_send "hello"` OR a manual `hello`↵ is typed, then exactly one line `hello` is appended to that agent's output.
- AE2. **Covers R5.** Given a running step, when `q` (or `exit`) is typed manually OR a `finish` command is sent, then the step ends and the workflow advances.
- AE3. **Covers R11.** Given two workflow runs executing concurrently with identically-labeled steps, when a driver sends `finish` to its run's instance, then only that run's step ends and the other run's identically-labeled step is unaffected.
- AE4. **Covers R6.** Given two parallel branches labeled `a` and `b`, when the driver sends `type_and_send "to-a"` to handle `a`, then branch `a`'s output shows `to-a` and branch `b`'s output does not.
- AE5. **Covers R13.** Given an interactive step that has spawned but not yet finished rendering, when a driver awaits the readiness signal, then the signal resolves only once the agent is idle-waiting — a snapshot taken after it reliably shows the agent in its waiting state.
- AE6. **Covers R12.** Given the driver sends a `type_and_send` command over the control channel, when it awaits the command's ack, then the await resolves only after the agent has processed that command.

---

## Success Criteria

- A high-level real-tmux test can drive a two-step workflow (interactive then headless) to a finished state with zero timing-based flakiness across repeated runs, asserting pane state at each step.
- Two parallel branches and two concurrent runs can be driven independently with no observed cross-talk.
- A downstream implementer (ce-plan) can build this without inventing the addressing model, the command vocabulary, the mode split, or the readiness semantics — all are fixed here.
- The design leaves a clear, documented path for an autonomous QA agent to address instances by logical address over a future non-file transport, without re-architecting addressing.
- No new leaked-daemon class of flakiness is introduced; the suite's process count returns to baseline after each test.

---

## Scope Boundaries

- Real manual typing in headless mode is excluded — it would require orch to give autonomous spawns a stdin/PTY, which they do not have today. Control-file drive covers headless; manual typing is a TUI capability.
- The screenshot/snapshot testing utilities and the autonomous QA agent itself are not built here. The address/transport split (R10) keeps the door open for the QA agent.
- No changes to real Claude/Codex runner behavior.
- No command vocabulary beyond `type_and_send` and `finish` for this version.
- No socket/IPC transport now — file-based control only; the design must merely not preclude a later transport swap.

---

## Key Decisions

- Extend puppet mode rather than build a separate fake: keeps one externally-driven fake and reuses the control-file + ack machinery. (User decision.)
- Keep both headless and interactive modes despite identical agent behavior: the value is exercising orch's two distinct integration paths (transcript pipeline vs. PTY passthrough), which mirror how real Claude/Codex run. Collapsing to one mode would halve test coverage.
- Address instances by step cache key under the run's state dir: reuses `deriveStepKey` and the R20 collision guard, makes cross-run isolation structural, and avoids inventing a second identity scheme. (Rationale grounded in `src/core/workflow.ts` cache-key derivation and the R20 guard.)
- Require a stable label (`as:`) to individually address a parallel branch: this is how the existing identity/collision model already works, not a new constraint.
- Add a readiness signal: directly serves the predictability goal by removing the agent-startup race the feature exists to eliminate.

---

## Dependencies / Assumptions

- Builds on `src/runners/scripted-fake/` puppet mode (control file, ack dir, NDJSON commands) and the real-tmux harness in `tests/helpers/real-tmux/`.
- Assumes the per-`runId` state dir (`.orch/state/<runId>/`) remains the isolation boundary for control files.
- Assumes control files remain race-safe by construction (created and tailed from cursor 0, so commands appended before the agent is ready are not lost). Verified against `src/runners/scripted-fake/__entry.ts` puppet reader.
- The readiness signal's exact shape (a new `StepLifecycleEvent` variant vs. a filesystem ready-marker) is a planning decision; both are viable.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R7][Technical] At what point is the per-instance control path resolved? Today the launcher derives `test-control/<stepName>.ndjson` before the runner spawns, where `subPath`/`parallelDepth` are not yet known. Planning must decide whether to defer path resolution to step-run time or pre-compute paths from the authored cache keys.
- [Affects R8][Technical] The exact handle API the real-tmux harness exposes for per-instance targeting (e.g., `harness.agent(labelPath)`), given it currently exposes only `left`/`right` pane handles.
- [Affects R13][Technical] Whether the readiness signal is a new `StepLifecycleEvent` variant surfaced through the host, a filesystem ready-marker the driver polls, or both — and how a future non-file transport would carry it.
- [Affects R6][Technical] How a heterogeneous `parallel([...])` branch acquires its label end-to-end so the test handle resolves to the right control file.
- [Affects R14][Technical] The precise teardown hook that guarantees the interactive TUI process and any tailing processes are reaped on run end / harness teardown.
