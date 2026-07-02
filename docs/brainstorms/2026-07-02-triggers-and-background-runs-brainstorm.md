---
date: 2026-07-02
topic: triggers-and-background-runs
---

# Triggers, Background Runs, and Mission Control

## Summary

Add a control plane to orch: developers author a **trigger** — a long-running, reactive workflow whose loop the runtime owns — that watches a schedule or a developer-authored event source (poll or push) and launches other workflows in the background, deduped by a subject key, with a machine-wide view (`orch ps`) to observe every live run and pull any one to the foreground (`orch attach`).

---

## Problem Frame

Today every orch run is foreground and terminal-bound. You start `orch run <wf>`, watch it, and when it ends the process ends. There is no way to run reactive, long-lived automation unattended, no view of what's running across projects, and no notion that a piece of work is "already being handled."

The developer wants to write their own automation *as TS in their project*: a process that, once started, watches for external conditions (a failed MR, a new Slack message, a webhook) and spawns workflows to deal with them — running for days, surviving terminal close and logout, without launching a second worker for something already in flight. The concrete pain today: when an MR fails, a human has to notice it and manually start a fix run; there is no way to say "watch for this and handle it, but don't step on a fix that's already running." orch has the run primitives but nothing above a single foreground run.

This is plumbing-first: orch should ship the primitives (detached launch, a global registry, dedup, mission control, custom event sources) and let developers write the reactive logic themselves. Predefined integrations (Slack, GitLab) are explicitly *not* the goal — the ability to author a custom source is.

---

## Actors

- A1. Developer / author: writes triggers, workflows, and custom sources as TS in their project.
- A2. Trigger: a long-lived reactive run whose loop is owned by the runtime; fires a handler per tick/event.
- A3. Launched workflow (child run): an independent run, spawned by a trigger, that does the actual work.
- A4. Supervisor: the lazily-started process that owns the loop, scheduling, and live event sources.
- A5. Operator (same person, later): observes runs via mission control and attaches to them.
- A6. Custom trigger source: a developer-authored adapter that produces events (poll or push).

---

## Key Flows

- F1. Author and start a trigger in the background
  - **Trigger:** developer runs `orch run <trigger> --background`.
  - **Actors:** A1, A4
  - **Steps:** author `defineTrigger({ on, dedup, run })` → start with `--background` → supervisor takes ownership → process detaches, terminal is free.
  - **Outcome:** trigger runs unattended, surviving terminal close/logout.
  - **Covered by:** R1, R2, R3, R10

- F2. Reactive launch with dedup
  - **Trigger:** a tick fires or a source yields an event.
  - **Actors:** A2, A3
  - **Steps:** handler runs (finite) → decides what work is needed → `ctx.launch(wf, args, { subject })` → orch checks the subject lease → launches a new run OR skips (in flight).
  - **Outcome:** at most one run per subject; the launch result records launched-vs-skipped.
  - **Covered by:** R12, R15, R16, R18, R20

- F3. Observe and attach (mission control)
  - **Trigger:** operator wants to see or steer running work.
  - **Actors:** A5
  - **Steps:** `orch ps` (optionally `--project`/`--worktrees`) lists live runs → `orch attach <runId>` brings one to the foreground → detach returns it to background.
  - **Outcome:** any background run can be inspected live and steered, then released.
  - **Covered by:** R13, R14, R19

- F4. History and audit
  - **Trigger:** operator asks "what did my trigger do?"
  - **Actors:** A5
  - **Steps:** `orch history <trigger>` → shows past ticks and, per tick, what was launched or skipped, plus the current in-flight subject set.
  - **Outcome:** after-the-fact accountability without having watched live.
  - **Covered by:** R20, R21

- F5. Author a custom source (e.g. Slack)
  - **Trigger:** developer needs events orch doesn't ship.
  - **Actors:** A1, A6
  - **Steps:** implement a `pollingSource` (return new events + a cursor) OR a `pushSource` (async generator holding a live connection, yielding events) → pass it as `on:` → handler stays unchanged.
  - **Outcome:** any event source is expressible in-project without changing orch.
  - **Covered by:** R5, R6, R7, R8, R9

---

## Requirements

**Authoring model**
- R1. A trigger is authored with `defineTrigger({ name, on, dedup, run })`; the runtime owns the infinite loop.
- R2. The `run` handler uses the existing `run()` / `step.define()` / `command()` idiom — no new authoring vocabulary for the body.
- R3. Each tick or event is a finite, ordinary run, so existing memoization, resume, and run-end semantics stay intact; there is never a `while(true)` in user code.
- R4. Level-triggered handlers (re-derive needed work from current state each tick) are the encouraged pattern for restart-safety; edge-triggered handlers are allowed.

**Trigger sources**
- R5. A trigger source is an adapter interface; orch ships `cron`, `webhook`, and `manual` as built-in instances of it.
- R6. Developers can author custom sources entirely in their project, without modifying orch (parity with how runners are adapters).
- R7. `pollingSource` calls a developer `poll` function on a schedule, persists a developer-returned cursor across ticks, and fires the handler once per returned event.
- R8. `pushSource` lets a developer hold a live connection (async generator) and yield events; orch fires the handler once per yield and provides an abort signal for teardown.
- R9. Swapping a source's flavor (poll ↔ push) does not require changing the handler.

**Background launch and mission control**
- R10. `orch run <trigger> --background` detaches the run so it survives the launching terminal closing and the user logging out and back in.
- R11. Running the same trigger without `--background` shows live progress in the two-pane view; `--background` changes only process ownership, not what is observable or recorded.
- R12. `ctx.launch(wf, args, opts)` starts the target workflow as its own independent background run (own run id, own state, own process) — not a sub-workflow; the trigger neither waits for it nor parents it.
- R13. `orch ps` lists every live run on the machine by default, with `--project` and `--worktrees` filters to narrow the view.
- R14. `orch attach <runId>` brings a background run to the foreground; detaching returns it to running in the background; runs move freely between the two.

**Dedup and subject identity**
- R15. A launch carries an author-supplied **subject** key identifying the unit of work; the name must not collide with orch's existing agent `sessionId` concept.
- R16. In-flight policy `skip` (default): if a run already owns the subject, the duplicate launch is dropped, and the result surfaces `launched` vs `skipped` (with reason) rather than failing silently.
- R17. In-flight policy `signal`: instead of launching, deliver the new payload to the run already handling the subject and record it in that run's state, so the in-flight workflow can absorb the new requirement. (Scope for v1 is an open question — see Outstanding Questions.)
- R18. Dedup is enforced by an atomic, per-subject lease; if the lease holder crashes, the lease is reclaimed automatically via a liveness check, so a dead run never blocks future work.

**Observability and history**
- R19. The registry of runs lives at machine level (outside any single project's `.orch/`) so `orch ps` can see across projects; runs self-register, and liveness for crashed background runs is pull-verified by probing the process at read time.
- R20. Each launched run records its subject and the trigger that launched it, producing an audit trail.
- R21. `orch history <trigger>` shows past ticks and, for each, what it launched or skipped; the current in-flight subject set is visible.

---

## Acceptance Examples

- AE1. **Covers R16.** Given a run already in flight for subject `mr-123`, when a trigger tick calls `ctx.launch(fixMr, …, { subject: 'mr-123' })`, then no second run starts and the call returns `{ status: 'skipped', reason: 'in-flight', subject: 'mr-123' }`.
- AE2. **Covers R11.** Given a trigger started without `--background`, when a tick fires and launches a child, then the operator sees the tick and the launch live in the two-pane view; given the same trigger started with `--background`, when the terminal is closed, then the trigger keeps running and the same tick/launch is later visible via `orch ps` / `orch history`.
- AE3. **Covers R7.** Given a `pollingSource` whose `poll` returned cursor `t5` last tick, when the next tick runs, then `poll` is called with `t5` and only messages after `t5` are delivered to the handler.
- AE4. **Covers R8.** Given a `pushSource` holding a live socket, when the supervisor tears the trigger down, then the abort signal fires and the generator stops cleanly without dropping the process.
- AE5. **Covers R18, R19.** Given the run holding the lease for subject `mr-123` was killed (`kill -9`, no clean end), when a later tick tries to launch for `mr-123`, then the stale lease is detected via liveness check and reclaimed, and the launch proceeds.

---

## Success Criteria

- A developer can, in one file plus one command, start a trigger that watches a custom source they wrote and launches workflows unattended — and trust it will not double-handle a subject.
- After hours away, the operator can answer "what ran, what's running, and what did each trigger launch or skip" from `orch ps` / `orch history` alone.
- Any event source (Slack, a queue, a file watcher) is expressible without a change to orch itself.
- `ce-plan` can proceed without inventing the authoring model, the source interface, the dedup semantics, or the observability surface — only their implementation.

---

## Scope Boundaries

- Team / remote / multi-machine registry sync — deferred; the design should not preclude it, but v1 is machine-local.
- An always-on managed daemon with its own start/stop/upgrade lifecycle — rejected for v1 in favor of a lazily-started supervisor that grows toward it later.
- Temporal-style durable history / continue-as-new machinery — out.
- Queueing of skipped launches — out for v1; `skip` is the default, queueing is a possible later policy.
- Built-in event-source adapters beyond `cron` / `webhook` / `manual` (Slack, GitLab, etc.) — out; these are developer-authored sources, not core guarantees.
- Cross-project launching (a trigger in project A spawning a run in project B) — technically possible under machine scope but not a v1 guarantee.

---

## Key Decisions

- Runtime owns the loop; each tick/event is a finite run: preserves the executor's memoization/resume/run-end invariants that an infinite user-space loop would break (unbounded state growth, ambiguous "running" status, meaningless resume).
- Sources are adapters, not a predefined zoo: matches the developer's stated intent to author custom triggers, and mirrors orch's existing "runners are adapters" philosophy; `cron`/`webhook`/`manual` are just the built-in instances.
- Lazily-started supervisor over an always-on daemon: keeps the simple case simple (no daemon to manage when you have no triggers) while still hosting long-lived sources when needed.
- Filesystem-backed machine registry + atomic per-subject lease + pid-based liveness: gives a cross-project view and correct dedup without standing up a lock server, and self-heals after crashes.
- Subject naming kept distinct from agent `sessionId`: avoids a real name clash with existing per-step session identifiers.

---

## Dependencies / Assumptions

- A new detached-spawn capability in `ProcessService` plus a re-exec of `orch run` is the assumed backbone for both `--background` and `ctx.launch` (the workflow body runs in-process today, not in tmux, so detachment is genuinely new).
- A registry integration modeled on the existing observe-only composite-host seam (as used by the cmux host) is assumed as the self-registration mechanism.
- The executor needs changes so a long-lived trigger does not accumulate unbounded per-tick state (e.g. launches that are not memoized steps); this is a known strain point, not yet designed.

---

## Outstanding Questions

### Resolve Before Planning

- [Affects R7, R8][User decision] Is real-time `pushSource` (live sockets) in v1, or does v1 ship poll-based custom sources first with push as a fast-follow?
- [Affects R17][User decision] Is the `signal` in-flight policy (deliver the new event into the already-running run and update its store) in v1, or is v1 `skip`-only with `signal` documented as the planned next step?
- [Affects R15][User decision] Final name for the subject / "session key" concept.

### Deferred to Planning

- [Affects R17][Needs research] How `signal` delivers a payload into a live run (a queue the run polls vs. an append to its state) and the workflow-side pattern for consuming it.
- [Affects R7][Technical] Where and how the polling cursor is persisted.
- [Affects R18][Technical] Lease liveness correctness under process-id reuse.
- [Affects R12][Technical] How structured launch arguments (beyond a prompt string) are passed to a detached child run.
