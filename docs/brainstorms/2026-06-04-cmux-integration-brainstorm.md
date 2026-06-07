---
date: 2026-06-04
topic: cmux-integration
---

# cmux Integration

## Summary

A `CmuxHost` that mirrors orch run state into the cmux terminal's sidebar and notifications: glanceable status pills (workflow / step / runner / mode) while a run is active, and desktop notifications when a run finishes, fails, or needs the human's attention. It rides orch's existing `Host` lifecycle seam, keeps all cmux code in one folder, and is a hard no-op when orch is not running inside cmux.

Delivered in two phases: **Phase 1** is the direct orch↔cmux integration driven entirely by orch's own lifecycle events (no agent changes). **Phase 2** adds claude/codex hooks so cmux is also notified when the *wrapped agent* is waiting for input mid-step.

---

## Phasing

- **Phase 1 — Direct orch integration.** The `CmuxHost`, status pills, and notifications driven by signals orch already emits through the `Host` seam (run start/end, step transitions, interactive-step start) plus the composition-root run-end hook. Includes the full not-in-cmux safety contract. Ships standalone value with zero changes to claude/codex. Covers R1–R6, R10–R16.
- **Phase 2 — Agent awaiting-input hooks.** The claude and codex runners detect when the wrapped agent is blocked on human input (via each agent's own hook mechanism) and emit a normalized `awaiting-input` event that `CmuxHost` turns into a notification. Research-gated (see Outstanding Questions). Covers R7–R9. Depends on Phase 1.

---

## Problem Frame

orch is increasingly run *inside* cmux — a Ghostty-based macOS terminal built for running coding agents in parallel across workspaces. cmux exposes a sidebar (status pills, progress, logs) and a notification system, and it normally auto-populates these by observing the agent process it spawned (its bundled `claude` wrapper injects a Notification hook and watches OSC sequences from the focused surface).

When orch is the thing running, that auto-detection goes dark. orch spawns claude/codex itself, through `ProcessService`, inside **tmux** panes — so cmux is two layers removed and sees orch's tmux process, not the agent's hooks or OSC output. The cmux sidebar shows nothing about the orch run, and cmux never notifies when an agent is blocked.

The cost lands hardest in the exact scenario cmux is built for: several agents running in parallel across workspaces. Today the operator has to keep visually checking each orch TUI pane to learn which run is working, which finished, which failed, and — most expensively — which has silently stopped to wait for human input. There is no glanceable signal and no pull-back notification, so attention is spent polling instead of being summoned only when needed.

---

## Actors

- A1. **Operator** — the human running orch inside cmux, often supervising several parallel runs across workspaces. Wants glanceable state and to be pulled back only when a run needs them.
- A2. **orch core** — the workflow executor that emits lifecycle events through the `Host` port (`src/hosts/host.ts`).
- A3. **Runner adapters** — `ClaudeRunner` / `CodexRunner`, which wrap the agent CLI and are the only components positioned to detect "the agent is waiting for input."
- A4. **cmux** — the terminal app exposing the CLI / socket that renders pills and notifications.

---

## Key Flows

- F1. **Run progresses inside cmux → sidebar + notifications update**
  - **Trigger:** an orch run starts in a cmux workspace (`CMUX_SURFACE_ID` present).
  - **Actors:** A1, A2, A4
  - **Steps:** run begins → pills set (workflow, step, runner, mode) → each step start updates the step/mode pills in place → an interactive step start fires a "needs you" notification → run settles → pills cleared, completion/failure notification fires.
  - **Outcome:** the operator can read run state at a glance and is notified at the moments that warrant attention.
  - **Covered by:** R1–R6, R10–R13

- F2. **Wrapped agent blocks on input → operator is notified**
  - **Trigger:** claude/codex, mid-step, reaches a permission prompt or otherwise needs the human.
  - **Actors:** A1, A3, A4
  - **Steps:** runner's agent-native hook detects the wait → runner emits a normalized `awaiting-input` event on the Host seam → `CmuxHost` fires a notification naming the run and agent.
  - **Outcome:** the operator is pulled back to the blocked run without having watched the pane.
  - **Covered by:** R7–R9, R12

- F3. **orch runs outside cmux → integration disappears**
  - **Trigger:** orch starts with no cmux environment (`CMUX_SURFACE_ID` absent, or socket mode `off`/unreachable).
  - **Actors:** A2
  - **Steps:** detection runs once up front → integration disables itself → zero cmux operations for the run's lifetime.
  - **Outcome:** identical behavior to orch with no cmux integration at all; no crashes, no stray side effects.
  - **Covered by:** R14–R16

---

## What the operator sees in cmux (sample run)

A `lint-fix` workflow with three steps — `plan` (autonomous) → `review` (interactive) → `build` (autonomous) — running in a cmux workspace:

```
RUN STARTS  (workspace: lint-fix)
   sidebar pills →  [▶ lint-fix]   [⚙ plan · 1/3]   [⚡ claude]   [auto]

step "plan" done → step "review" starts  (interactive)
   sidebar pills →  [▶ lint-fix]   [⚙ review · 2/3]  [⚡ claude]   [interactive]
   🔔 notify       "orch · lint-fix"  —  "⏸ step 'review' needs you"

step "build" running → agent hits a permission prompt  (awaiting-input detected)   ◀ Phase 2
   sidebar pills →  [▶ lint-fix]   [⚙ build · 3/3]   [⚡ claude]   [auto]
   🔔 notify       "orch · lint-fix"  —  "⏸ claude is waiting for your input"

RUN COMPLETES
   sidebar pills →  (cleared — no stale pills)
   🔔 notify       "orch · lint-fix"  —  "✅ completed in 4m12s"

  ── or, if it had failed ──
   🔔 notify       "orch · lint-fix"  —  "❌ failed at step 'build'"
```

The same run with **no cmux present** (plain terminal, `CMUX_SURFACE_ID` unset):

```
RUN STARTS
   CmuxHost detects no cmux  →  disabled for the whole run.
   0 cmux CLI calls.  Run proceeds exactly as it does today.
```

---

## Requirements

**Architecture / wiring** *(Phase 1)*
- R1. cmux integration is implemented as a `CmuxHost` consuming orch's existing `Host` lifecycle seam, composed alongside the active host (e.g. `TmuxHost`) via a small composite/fan-out host — not as a new event bus or plugin registry.
- R2. All cmux-specific code lives in a single module (e.g. `src/hosts/cmux/`), behind orch's single-public-barrel convention.
- R3. `CmuxHost` talks to cmux exclusively by running the cmux CLI through `ProcessService` (per CLAUDE.md rule #1). No direct socket, no `child_process`/`Bun.spawn` outside `ProcessService`.

**Status pills** *(Phase 1)*
- R4. While a run is active, the integration maintains sidebar pills for: current workflow, current step (with an `N/M` position), active runner (e.g. claude/codex), and mode (interactive/autonomous).
- R5. Pills are keyed so updates replace in place rather than accumulate; the step and mode pills update on each step transition.
- R6. All pills the integration created are cleared when the run ends (success, failure, or crash) — no stale pills survive the run.

**Awaiting-input detection (cmux-agnostic signal)** *(Phase 2 — research-gated)*
- R7. The claude and codex runners detect when the wrapped agent is waiting for human input, each using that agent's own hook mechanism (e.g. Claude `--settings` Notification/Stop hook; Codex `notify`).
- R8. Detection surfaces as a **normalized, cmux-agnostic** event on the Host seam — the runners contain no cmux-specific code (CLAUDE.md rule #2). The event is reusable by other consumers (e.g. the TUI highlighting the blocked pane) in the future.
- R9. `CmuxHost` translates the normalized `awaiting-input` event into a cmux notification that names the run and the waiting agent.

**Notifications** *(Phase 1)*
- R10. The integration fires a cmux notification when a run completes successfully (including a duration), and when a run fails (including the failing step).
- R11. The integration fires a cmux notification when an **interactive step** starts ("this step needs you"), derived from the `mode` carried on the `step:start` lifecycle event.
- R12. Notifications carry enough identity (workflow name, and step/agent where relevant) for an operator supervising multiple parallel runs to tell which run fired.
- R13. Run-completion / run-failure notifications are emitted from the composition root after the run settles (since `run-ended` is not delivered to the host), while step- and agent-level signals flow through the host events.

**Not-in-cmux safety (first-class)** *(Phase 1)*
- R14. The integration detects cmux availability once, up front (presence of `CMUX_SURFACE_ID`; respect socket mode `off`/unreachable), and when cmux is unavailable it is a hard no-op for the entire run: zero cmux CLI invocations.
- R15. Any cmux CLI failure at runtime (cmux quit mid-run, socket unreachable, non-zero exit) is swallowed and never propagates into the orch run — a failed pill/notify can never fail or alter a step.
- R16. A configuration switch can disable the cmux integration even when running inside cmux.

---

## Acceptance Examples

- AE1. **Covers R11.** Given orch is running in cmux, when a step with `mode: 'interactive'` starts, then a cmux notification fires naming that step as needing the operator.
- AE2. **Covers R7, R9.** Given orch is running in cmux and a claude step is mid-execution, when the agent reaches a permission prompt, then a normalized `awaiting-input` event is emitted and a cmux notification fires naming claude as waiting.
- AE3. **Covers R6.** Given a run created status pills, when the run ends in any terminal state (completed / failed / crashed), then every pill the integration created is cleared.
- AE4. **Covers R14.** Given `CMUX_SURFACE_ID` is unset, when a full run executes start to finish, then zero cmux CLI invocations are made and the run's observable behavior is identical to running with the integration absent.
- AE5. **Covers R15.** Given orch is running in cmux, when a cmux CLI call fails mid-run (e.g. cmux was quit), then the error is swallowed and the step and run complete normally.
- AE6. **Covers R10, R12.** Given two orch runs are active in different cmux workspaces, when one completes, then its completion notification identifies that specific workflow.

---

## Success Criteria

- An operator running several agents in parallel inside cmux can tell, without opening any orch pane, which run is active/blocked/done, and is notified the moment a run finishes, fails, or needs input.
- Running orch outside cmux is provably side-effect-free with respect to cmux (no calls, no crashes), verifiable by a test asserting zero `ProcessService` cmux invocations.
- A downstream implementer (`ce-plan`) can build this without inventing product behavior: the lifecycle→cmux mapping, the pill set, the notification triggers, and the not-in-cmux contract are all specified here; the one open mechanism (hook routing) is called out as research.

---

## Scope Boundaries

- **Progress bar** (`set-progress`) — excluded; the orch TUI pane already shows step progress and it adds notification/visual noise.
- **Sidebar log trail** (`log`) — excluded for the same reason; the TUI already shows the step trail.
- **Generalized observer / plugin registry** (Slack, webhooks, N consumers) — deferred. The composite-host start makes promoting to a registry a cheap mechanical refactor when a second external consumer actually exists.
- **Persistent Unix-socket transport** and cmux's richer API (browser automation, Feed Bridge / Vibe Island approval gates) — deferred along with the socket; the CLI-via-`ProcessService` path is the v1.
- **Explicit `ask()`-gate notifications via a `PromptService` decorator** — a likely follow-on, not v1. v1's "needs you" coverage is interactive-step-start (R11) plus agent awaiting-input (R7–R9).
- **TUI consumption of the `awaiting-input` event** (e.g. highlighting the blocked pane) — out of scope here, but the event is designed cmux-agnostic so it is possible later without rework.

---

## Key Decisions

- **Composite host + `CmuxHost`, not a registry/event-bus.** The `Host` port is already the observable seam (two consumers exist: `PlainHost`, `TmuxHost`). A ~15-line composite gives multi-consumer fan-out; a registry's carrying cost is only justified with 3+ heterogeneous consumers and runtime config toggling, which do not exist yet.
- **cmux CLI via `ProcessService`, not a raw socket.** Reuses an existing mockable `*Service` edge (rules #1, #3), needs no new port, and orch's event cadence (seconds-to-minutes) makes per-event spawn overhead a non-issue. Socket transport is the deferred upgrade path.
- **Awaiting-input is a general orch signal; cmux is one consumer.** Detection is runner-specific (each agent's hook mechanism differs) but emits a normalized, cmux-agnostic event on the Host seam — keeping cmux out of the runners (rule #2) and the signal reusable. Trades strict "all cmux code in one folder" for architectural correctness; the cmux folder still owns the notify translation, not the detection.
- **Not-in-cmux is a no-op, detected once up front.** Promoted to a first-class requirement (R14–R16): unavailability is decided early and the integration issues zero cmux operations thereafter, so a missing/closed cmux can never crash or perturb a run.
- **Surfaces limited to status pills + notifications.** The two highest-signal, lowest-noise cmux surfaces; progress and log are excluded to avoid duplicating the TUI.

---

## Dependencies / Assumptions

- The `cmux` CLI is on `PATH` and inherits socket access when orch runs inside cmux (orch is spawned within the cmux terminal, satisfying the default `cmuxOnly` socket mode). *Verify during planning.*
- The cmux CLI surface used (`notify`, `set-status`/`clear-status`) matches the documented commands at the time of build; exact flags/JSON to be pinned during planning.
- Claude Code and Codex each expose a hook/notify mechanism capable of signaling "awaiting input" to an out-of-process supervisor (orch). *This is the central feasibility assumption — see Outstanding Questions.*

---

## Outstanding Questions

### Resolve Before Planning

- *(none — product scope is settled; the open items below are technical/research and belong in planning.)*

### Deferred to Planning

- **[Affects R7–R9][Needs research] How does the agent's "awaiting-input" hook callback reach orch through the tmux wrapping layer?** This is the riskiest unknown. **Research approach: `git clone` cmux and analyze how cmux itself does this** — how its bundled `claude` wrapper injects `--settings` and a `--session-id`, how the Notification hook routes back through its socket, and what OSC sequences (9 / 99 / 777) it relies on. Reproduce the equivalent routing for orch's case, where the agent runs inside an orch-managed tmux pane rather than a cmux-spawned surface. Determine the Codex equivalent (`notify` program/config) the same way.
- **[Affects R3, R4][Technical] Exact cmux CLI invocations** — confirm the precise `set-status` / `clear-status` / `notify` flags, JSON payload shape, icon/color/priority values, and notification urgency levels against the installed cmux version (cross-check the cloned source from the item above).
- **[Affects R5, R6][Technical] Pill key namespacing** — whether a single cmux workspace can host more than one concurrent orch run; if so, namespace pill keys by `runId`, otherwise static keys suffice.
- **[Affects R13][Technical] Composition-root hook for run-end notifications** — wire the completed/failed notify where the run settles (around `executeWorkflowFn` in `src/cli/main.ts`), since `run-ended` is append-only to `lifecycle.ndjson` and not delivered to the host.
- **[Affects R14, AT-9][Technical] Exact probe mechanism for cmux availability at startup** — whether CmuxHost probes via a cmux CLI call, a socket connect, or a secondary env var; must be pinned during planning to write AT-9.
- **[Affects R16, AT-11][Technical] Config switch form** — whether the disable switch is a field in `OrchestratorConfig` (e.g. `cmux.enabled: false`), an env var (e.g. `ORCH_CMUX_DISABLED`), or both; must be pinned during planning to write AT-11.

---

## Acceptance Tests

The behavioral acceptance criteria for this feature have been derived from this brainstorm and live in the sidecar: **[2026-06-04-cmux-integration-brainstorm-acceptance-tests.md](2026-06-04-cmux-integration-brainstorm-acceptance-tests.md)**.

If all listed tests pass, the feature works as specified without reading the implementation. Each test is identified by a stable AT-ID; track implementation status there.

**Phase 1 tests (AT-1 – AT-12):** cover status pills, notifications, no-op safety, error swallowing, and workflow identity — all directly implementable once planning pins the cmux CLI shapes, the probe mechanism (AT-9), and the config switch form (AT-11).

**Phase 2 tests (AT-13 – AT-16):** cover the normalized `awaiting-input` signal from runners and its translation to a cmux notification. Research-gated pending the hook-routing investigation.

| AT-ID | Behavior |
| ----- | -------- |
| AT-1  | First step start sets all four sidebar pills with step position |
| AT-2  | Step transition refreshes step and mode pills in place, no accumulation |
| AT-3  | Interactive step start fires "needs you" notification (not fired for autonomous) |
| AT-4  | Successful run fires completion notification with duration and workflow name |
| AT-5  | Failed run fires failure notification with failing step name and workflow name |
| AT-6  | All pills cleared when run ends successfully |
| AT-7  | All pills cleared when run ends with failure |
| AT-8  | CMUX_SURFACE_ID absent → zero cmux CLI invocations, identical run behavior |
| AT-9  | cmux unavailable at startup → zero subsequent cmux calls, run proceeds normally |
| AT-10 | cmux CLI failure mid-run is swallowed; step and run complete normally |
| AT-11 | Config switch disables integration even when CMUX_SURFACE_ID is set |
| AT-12 | Notification identifies the specific workflow (parallel-run disambiguation) |
| AT-13 | *(Phase 2)* Claude runner emits normalized awaiting-input event when agent blocks |
| AT-14 | *(Phase 2)* Codex runner emits normalized awaiting-input event when agent blocks |
| AT-15 | *(Phase 2)* awaiting-input event contains no cmux-specific content |
| AT-16 | *(Phase 2)* CmuxHost fires agent-blocked notification on awaiting-input event |
