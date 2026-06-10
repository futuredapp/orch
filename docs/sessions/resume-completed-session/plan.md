---
status: active
type: feat
title: "feat: Re-open a finished run from the CLI (resume read-only + interactive failed view + orch retry)"
created: 2026-06-09
origin: docs/sessions/resume-completed-session/brainstorm.md
acceptance_contract: docs/sessions/resume-completed-session/acceptance-tests.md
scope_tier: deep
---

# feat: Re-open a finished run from the CLI — read-only `completed`, interactive `failed`, and `orch retry`

## Summary

Today `orch resume <id>` against a finished run is a dead end: a `completed` run throws
`ResumeError` (`src/core/workflow.ts:2109`, mapped to `EXIT.CANNOT_RESUME`), and a `failed` run
**silently re-runs the failed step for real** (the guard only fires on `completed`). This feature
turns both into deliberate, useful re-entry:

- **`completed`** opens the existing read-only end-of-run TUI without executing anything and
  without mutating any persisted state, lifecycle event, cmux pill, or log — a *pure* open.
- **`failed`** opens the existing `'failed'` view, now **interactive**: `[r]` retry the step,
  `[c]` retry-and-continue to the end, `[q]` quit, `⏎` inspect (pure). Merely opening and quitting
  mutates nothing; only `[r]`/`[c]` mutate, and they mutate coherently.
- A new **`orch retry <id>`** verb = `orch resume <id>` + auto retry-and-continue, acting only on
  `failed` runs, rejecting every other status with a non-zero exit.

The work splits cleanly by effort (called out in the acceptance-tests feasibility appendix): the
**completed read-only open is cheap** (the `'completed'`/`'failed'` `StepsViewState` already
projects from `state.json` without executing — `project-steps-view.ts` `finalizeView`); the
**failed interactive retry/continue is net-new infra** (a host→CLI action channel, a single-step
execution primitive, and a shared configurable retry-instruction seam). The plan follows that
fault line: Phase 1 ships the cheap, self-contained read-only slice; Phase 2 builds the hard
interactive retry core and flips `failed` behavior; Phase 3 adds the thin `orch retry` verb on top.

**Behavioral modes at a glance (the contract this plan must satisfy):**

| Invocation | `completed` | `failed` | `crashed` / `running` |
|---|---|---|---|
| `orch resume <id>` (TTY) | read-only open (P1) | interactive failure view (P2) | resume for real (unchanged) |
| `orch resume <id>` (no TTY) | refuse, name status, non-zero (P1) | refuse, non-zero (P2) | resume for real (unchanged) |
| `orch retry <id>` (TTY) | reject, non-zero (P3) | open + auto retry-and-continue (P3) | reject, non-zero (P3) |
| `orch retry <id>` (no TTY) | reject, non-zero (P3) | run configured default, never block (P3) | reject, non-zero (P3) |
| bare `orch resume` | status-aware confirmed fallback (P2) | status-aware confirmed fallback (P2) | resume for real (unchanged) |

---

## Requirements traceability

This plan is bound to the human-reviewed acceptance contract in
[`acceptance-tests.md`](acceptance-tests.md) (AT-1..AT-22, AT-R1..AT-R11) and the decisions
D1–D8 in [`brainstorm.md`](brainstorm.md). Every AT is mapped to exactly one owning unit below;
the AT→unit map is in the Verification section. The sibling
[`in-tui-failure-resume-brainstorm.md`](in-tui-failure-resume-brainstorm.md) is **out of scope**
here — but the two share the `'failed'` view, the `[r]`/`[c]` action semantics, and the configured
instruction source (D7 / sibling D5). This plan **builds the shared retry primitive** because it is
the first feature to need manual retry; the sibling consumes the same seam later (see Assumptions).

---

## Key technical decisions

- **KTD-1 — Route the pure open around `executor.resume()` entirely.** The read-only/interactive
  open path does **not** call `WorkflowExecutor.resume()` (which unconditionally
  `setStatus('running')` at `src/core/workflow.ts:2110`), does **not** call `writeResumePreamble`
  (`src/cli/commands/resume.ts:90` — it appends a `run:resumed` lifecycle entry), and installs a
  **no-op cmux host** so the teardown `notifyRunEnd` hook (`resume.ts:284`) cannot clear/flip the
  completed pill. This is the mechanical core of D6's zero-mutation guarantee. Rationale: the
  guarantee is concretely "don't emit `run:ended` and don't run teardown side-effect hooks" (see
  the `cmux-run-end-bound-to-teardown` learning); the cleanest enforcement is a dedicated open path
  that never touches the executor.

- **KTD-2 — `ResumeError` is narrowed, not deleted (resolves brainstorm open Q1).** The
  `completed` guard at `workflow.ts:2109` stays as a defensive backstop on `executor.resume()`
  (still reachable for `crashed`/`running`), but is **never hit** for a normal finished run because
  the new open path bypasses the executor. `orch retry`'s non-`failed` rejection (D4) gets its own
  status-named check in the retry command, mapped to a non-zero exit (`EXIT.CANNOT_RESUME` reused,
  or a dedicated `EXIT` code — implementer's call; the *non-zero + status-named message* is the
  fixed contract). No currently-reachable user path prints "cannot resume" for a normal finished
  run (AT-6).

- **KTD-3 — Reuse the existing `ConfirmService`, don't invent a prompt service.**
  `src/services/prompt/confirm-service.ts` already defines
  `ConfirmService.confirm(question, defaultAnswer)` with `FakeConfirmService` (test),
  `ReadlineConfirmService` (real), and `parseYesNo`/`confirmSuffix` helpers. The status-aware
  bare-resume fallback (D5) wires this existing port into the resume deps. Rationale: the
  feasibility appendix assumed a new `FakePromptService.confirm()` was needed; it already exists.

- **KTD-4 — Lift the hardcoded recovery nudge into a shared, configurable instruction seam with a
  built-in default.** `RECOVERY_NUDGE = 'continue'` (`src/core/workflow.ts:1332`) is currently
  hardcoded and reachable only from the autonomous loop. Lift it to a parameter threaded through
  `RecoveryLoopDeps`/`buildRecoveryCommand` with the existing string as the built-in default, so
  manual retry can pass the configured instruction. This **is** the "one instruction source" of D7
  for now; the sibling's richer per-step/workflow schema points at the same seam later (see
  Assumptions). Rationale: D7 explicitly allows a built-in default when nothing is configured, so
  this feature is shippable without the sibling's schema.

  Two boundaries this seam must respect so it doesn't under-deliver D7 *or* expand into the sibling's
  scope:
  - **Retry (`[r]`/`orch retry`) and continue (`[c]`) are conceptually distinct instructions
    (D7 names both).** The resolver seam must let them resolve to *different* strings, even though
    both fall back to the **same** built-in default (`'continue'`) until a config schema exists.
    Model it as `resolve(kind, configured ?? default)` with `kind ∈ {retry, continue}`, not a single
    flat nudge — so the sibling can later supply distinct values without re-threading the seam.
  - **The interactive *typed-override* UI is the sibling's shared TUI and is OUT OF SCOPE here.**
    D7's "may be accepted or overridden with a typed nudge (same TUI as the sibling)" rides on the
    sibling's unbuilt config/override surface; the brainstorm Non-goals explicitly defer "the
    configured retry/continue instruction *schema*" to the sibling. What this feature **must** ship
    (and AT-R5 tests) is *delivery of the configured/default instruction* to the runner on `[r]`/`[c]`
    /`orch retry`. The typed-override input box is **not** built here; when the sibling lands it, it
    feeds the same `resolve(kind, …)` seam. (Surfaced as an explicit limitation in U4/U6 rather than
    a silent omission — see Finding-6 note in Test strategy.)

- **KTD-5 — `[c]` reuses existing resume re-run; `[r]` needs a net-new single-step primitive.**
  `[c]` retry-and-continue ≈ today's `executor.resume()` re-run semantics (re-run the failed step,
  proceed to completion), now triggered by a user action instead of at the prompt. `[r]`
  retry-the-step needs a **"run exactly one step then re-park"** mode that does not exist today —
  the executor runs the whole workflow body (research confirms no single-step primitive). Build it
  in `src/core/workflow.ts`.

- **KTD-6 — Manual retry must invalidate the per-step transcript tee (cache-replay coherence).**
  Per the `autonomous-transcript-rendering` learning, warm-cache `⏎` replay reads the persisted
  per-step `logs/agents/<step>/formatted_output.ansi` tee. A manual retry rewrites the step's
  events, so the open path must invalidate/rewrite that tee or a later `⏎`/`orch resume` replays
  stale pre-retry bytes. Verify for **both** Claude and Codex formatters (Codex `turn.*` has
  silently broken here before).

- **KTD-7 — Parallel-step failure granularity defers to existing resume semantics (resolves
  brainstorm open Q2 for this feature).** If the failed step is a parallel block (`ParallelError`),
  `[r]`/`[c]` re-run at the **same granularity today's `executor.resume()` does** (the whole block,
  via cache-replay of already-succeeded branches). No new branch-level granularity is introduced
  here; if the sibling decides otherwise, it changes the shared primitive, not this feature.

- **KTD-8 — Parked-after-`[r]` state is migration-free: status stays `failed`, the step's
  attempt-state carries the success.** After `[r]` re-runs the failed step and it passes, the run's
  `status` **stays `failed`** (the terminal status is not advanced until a `[c]`/continue actually
  drives it to `completed`); only the failed step's persisted attempt/outcome record flips to
  success. `projectStepsView`/`finalizeView` re-derives "this step retried-ok, continue available"
  from that **step-level** state, so the failed interactive view re-opens with the previously-failed
  step shown ok and `[c]` still offered. This is the concrete answer to "what is the run after a
  successful retry-only action": it keeps `RunState.schemaVersion` at `5` (no migration) while
  giving AT-R1/AT-R10 a coherent representation, and it avoids inventing a transient lifecycle status
  the existing step-level model already expresses. If review finds the step model *cannot* carry a
  retried-ok outcome distinctly from the original failure, that is the one place this plan would need
  a schema field — flag it rather than overloading an existing field silently. Rationale: the
  in-between state ("failed step retried successfully, workflow parked before later steps") is a real
  state AT-R1 creates; leaving it undefined lets U5/U6 pass a runner-invocation test while corrupting
  later resume semantics.

---

## System-wide impact

- **CLI surface** (`src/cli/main.ts`, `src/cli/commands/resume.ts`, new `retry.ts`) — a new verb
  and a status-branching open path.
- **Core executor** (`src/core/workflow.ts`, `src/core/recovery/loop.ts`) — a single-step
  execution mode and a lifted instruction parameter.
- **Two-pane host** (`src/hosts/two-pane/`) — new intent types, keybindings, and a third
  foreground-shutdown outcome threaded view→host→CLI.
- **cmux integration** (`src/hosts/cmux/cmux-host.ts`) — the pure open must not fire `run:ended`;
  a successful retry-and-continue legitimately fires `failed→completed`.
- **Runners** (`src/runners/claude/`, `src/runners/codex/`) — `forkResumeCommand` lifted out of
  the autonomous-loop-only path; cross-runner parity validated (Codex session-id capture).

No schema migration: `RunState.schemaVersion` stays `5`; `recoveryLog`/`sessionId` fields already
exist, and the parked-after-retry state rides on existing step-level attempt state (KTD-8) rather
than a new run status. No public-API barrel change beyond the new CLI verb (reconcile `docs/public/`
only if the verb is documented there).

---

## Phase 1 — Read-only `completed` open (the cheap, self-contained slice)

**Status: done**

Delivers the **completed read-only open** end-to-end: `orch resume <completed-id>` opens the
read-only end-of-run TUI with a verifiable zero-mutation guarantee, plus headless refusal and
regression guards. In this phase `orch resume <failed-id>` is **left unchanged** (still silently
re-runs — interim, flipped in Phase 2), and bare `orch resume` keeps today's behavior (the
status-aware fallback lands in Phase 2 where the failed view exists). The completed read-only open
needs **no execution infra**.

**Rollout boundary (not a releasable "finished-run re-entry" feature on its own).** Phase 1 is a
*completed-only* slice, safe to merge behind `bun run check`. It must **not** be announced or
documented as the "re-open a finished run" feature, because the most dangerous behavior this feature
exists to remove — `orch resume <failed-id>` silently re-running the failed step (D2/D3/D6, AT-2,
AT-R4, AT-20 failed half) — is still present until U6 flips it. Shipping the completed branch alone
would make the command *feel* fixed while preserving the failed-run surprise. The user-visible
"finished-run re-entry" rollout boundary is **after U6** (and after U7 for bare `resume`). If a
contract owner wants the failed path made safe *earlier* without the full interactive view, the only
acceptable interim is to **refuse** an explicit `failed` finished-run (status-named, non-zero — the
U3 refusal extended to `failed`), never to keep silently re-running; treat that as an optional,
owner-approved variant, not a default of this plan.

### AI-implementable tasks

#### U1. Side-effect-free finished-run open path (read-only container)

- **Goal:** A new open path that, given a finished run's loaded `state.json`, launches the
  two-pane host in terminal/replay mode and projects via the existing
  `projectStepsView`/`finalizeView` — **without** calling `executor.resume()`. `orch resume
  <completed-id>` branches into it. Reuses `Host.attachForeground()` + the `Promise.race`
  shutdown dance (per the `two-pane-auto-attach` learning).
- **Requirements:** D1, D2 (completed row); AT-1, AT-4, AT-5, AT-6 (completed half), AT-18
  (completed view reachable for inspect).
- **Dependencies:** none.
- **Files:**
  - `src/cli/commands/resume.ts` — status branch: `completed` → new open path.
  - `src/cli/commands/open-finished.ts` *(new)* — the read-only open (load state, build host,
    project, await foreground shutdown, teardown). Keep ≤ 300 lines.
  - `tests/...` full-host scenario opening a pre-finished `completed` fixture (see U-shared note).
  - `tests/...` unit for the status-branch routing in `resume.ts`.
- **Approach:** Branch in `resumeCmd` on the loaded `state.status`. For `completed`, call
  `openFinished()` which never invokes the executor and passes a no-op cmux host (full
  suppression is U2's concern; U1 establishes the path + the viewer renders). A clean `q` resolves
  `awaitForegroundShutdown()` with `'quit'` → exit `0`.
- **Patterns to follow:** `projectStepsView`/`finalizeView` (`project-steps-view.ts:284`) for pure
  projection; `wrapHostWithStepsView` + `awaitForegroundShutdown` (`tmux-host.ts`) for the attach
  lifecycle; the existing `resumeCmd` host-construction block for deps shape.
- **Test scenarios:**
  - Covers AT-1. Given a `completed` fixture run + a TTY, when `orch resume <completed-id>`, then
    the read-only end-of-run view renders (header `orch · <wf> · <id> · completed`, footer `run
    completed · q to quit · ⏎ to inspect`) rather than an error — assert via the rendered left
    steps pane (full-host fake-agent scenario).
  - Covers AT-4. Given the completed read-only viewer open, when the user quits (`q`), then the
    process exits `0` — assert via exit code.
  - Covers AT-5. Given a `completed` run backed by a `FakeRunner`, when opened read-only, then the
    runner boundary records **zero** step invocations — assert via a spy runner.
  - Covers AT-6 (completed half). Given a `completed` run, when `orch resume <id>`, then stderr
    never contains the "cannot resume" message and the exit code is not `CANNOT_RESUME`.
  - Covers AT-18 (completed half). Given the completed viewer open on a run with a past interactive
    step, when the user `⏎`-inspects it, then the step's replay shows in the right pane.

#### U2. Suppress lifecycle / cmux / log side effects on the pure open

- **Goal:** Make the U1 open path provably side-effect-free: no `setStatus('running')`, no
  `writeResumePreamble`, no `run:ended` (or other run-lifecycle) emission, a no-op cmux host with
  the teardown `notifyRunEnd` hook neutralized, and no new run-log writes.
- **Requirements:** D6 (completed half); AT-14, AT-15, AT-16, AT-17 (completed), AT-19 (completed
  half — inspect purity).
- **Dependencies:** U1.
- **Files:**
  - `src/cli/commands/open-finished.ts` — skip preamble; install no-op cmux host; do not pass a
    `beforeTeardown` that calls `notifyRunEnd`.
  - `src/hosts/cmux/cmux-host.ts` — confirm/extend `createNoOpCmuxHost` covers the open path; if
    teardown `notifyRunEnd` is wired unconditionally upstream, gate it for the open path.
  - `tests/...` byte-for-byte `state.json` before/after; logs-dir before/after; a lifecycle-event
    consumer asserting no `run:ended`; cmux surface asserting no notification/pill change.
- **Approach:** The open path constructs the same viewer as U1 but threads a no-op cmux host and a
  no-op preamble. Gate cmux subprocess tests with `ORCH_DISABLE_CMUX` (per the env-passthrough
  learning) so they never drive a real sidebar.
- **Patterns to follow:** `createNoOpCmuxHost` (`cmux-host.ts`); `FileStateStore.loadRun` as the
  on-disk observation surface; the `cmux-run-end-bound-to-teardown` learning (run-end vs teardown
  are deliberately separate moments).
- **Test scenarios:**
  - Covers AT-14 (completed). Given a `completed` run with `state.json` captured, when opened then
    quit without acting, then `.orch/state/<runId>/state.json` is byte-for-byte identical
    (`status`/`endedAt` unchanged).
  - Covers AT-15. Given the same open→quit, then no `run:ended` (or other run-lifecycle) event was
    emitted — assert via a test lifecycle-event consumer.
  - Covers AT-16. Given a cmux-integrated env, when open→quit, then no cmux notification fired and
    no status pill was cleared/set/changed — assert via the cmux host surface (gated
    `ORCH_DISABLE_CMUX` for unrelated sidebars).
  - Covers AT-17. Given `logs/` captured before, when open→quit, then no new run-log entries were
    written — assert via filesystem diff or a `SessionLogger` spy recording zero appends.
  - Covers AT-19 (completed half). Given a `⏎`-inspect in the completed view with `state.json`
    captured before, when the inspect completes, then `state.json` is unchanged.

#### U3. Headless refusal (completed) + regression guards

- **Goal:** Explicit `orch resume <completed-id>` with **no TTY** refuses (message names the run +
  its `completed` status, non-zero exit), never opening/hanging/mutating. Lock in regressions:
  `crashed`/`running` still resume for real; bare resume with no runs unchanged; ambiguous-prefix
  unchanged.
- **Requirements:** D8 (resume half, completed); AT-20 (completed half), AT-21 (bare no-TTY,
  completed-only fixtures), AT-7, AT-8, AT-13, AT-22, AT-6.
- **Dependencies:** U1.
- **Files:**
  - `src/cli/commands/resume.ts` — TTY detection at the open branch (interactivity is already
    threaded via `CliOpts.interactivity`; reuse it, mirror the existing no-TTY exit-2 + `--no-attach`
    contract from `two-pane-auto-attach`).
  - `tests/...` lifecycle/no-TTY scenarios for refusal; regression assertions for crashed/running.
- **Approach:** Before opening a finished run, if not interactive, print the status-named refusal
  and return non-zero. Leave `crashed`/`running`/no-runs/ambiguous-prefix on the unchanged path and
  add explicit regression assertions so Phase 2/3 cannot silently break them.
- **Patterns to follow:** existing `mapResumeError`/exit-code mapping (`resume.ts:70`); the no-TTY
  exit contract in the `two-pane-auto-attach` learning.
- **Test scenarios:**
  - Covers AT-20 (completed half). Given no TTY + a `completed` run id, when `orch resume <id>`,
    then it refuses with a message naming the run + `completed` status and exits non-zero; no TUI,
    no hang, no mutation — assert stderr + exit code + unchanged `state.json`.
  - Covers AT-21. Given no TTY, no resumable run, only `completed` finished runs, when bare `orch
    resume`, then today's "no resumable run found" behavior (non-zero, no prompt, no auto-open).
  - Covers AT-7 (regression). Given a `crashed` run, when `orch resume <crashed-id>`, then it
    continues executing as before — assert persisted state advances past the crash point.
  - Covers AT-8 (regression). Given a `running` run, when `orch resume <running-id>`, then it
    resumes and progresses to completion as before.
  - Covers AT-13 (regression). Given no runs at all, when bare `orch resume`, then unchanged "no
    resumable run found" — assert stderr + exit code.
  - Covers AT-22 (regression). Given an ambiguous run-id prefix, when `orch resume <prefix>`, then
    existing ambiguous-prefix handling is unchanged — assert stderr + exit code.

### Blocked-on-user-input

- None. Phase 1 is fully AI-implementable.

---

## Phase 2 — Interactive `failed` view + retry core + status-aware fallback

**Status: done** — U4 (instruction primitive) **done**; U5 **done**
(U5a single-step executor primitive `executor.retryStep` + U5b host→CLI action
channel both landed + tested); U6 (interactive `failed` open wired end-to-end)
**core landed** (round 4 — the CLI open loop, the `failed`-branch routing flip,
the shared resume-execution seam, and integration tests for the
retry/continue/quit/no-TTY behavior; the host-free `retryAndContinue` seam for
U8 is pinned as `runResumeExecution`); **U7** (status-aware bare-resume
fallback) **done** (round 5 — the `bareFinishedFallback` path: resumable
preferred, status-distinguishing confirm via the existing `ConfirmService`,
matching-view open on `y` / "nothing to resume" on `N`, no-TTY never prompts;
AT-9/AT-10/AT-11(completed)/AT-12 integration-proven). Round 6 closed the
remaining **non-gated** observable assertions: **AT-R10a** (KTD-8 parked state —
`[r]`-pass → quit → reopen the failed view, zero re-runs) and **AT-R10**
(`[c]→completed` → read-only reopen, state coherent) are now integration-proven
in `open-failed.test.ts`. All Phase 2 **implementation units (U4–U7) are landed**
and all non-gated behavior is integration-proven. The only residual is the
**gated full-host / real-CLI observable assertions** that cannot run without a
real tmux or a real Claude/Codex binary — the full-host *rendered-footer*
assertions for AT-2/AT-3, real fork/session-resume + prompt-recording for AT-R5,
the cmux-pill AT-R11, and the `⏎`-inspect-purity AT-18/19 failed half. These are
**not new product code**; they belong to the gated `bun run check:release`
level (auto-skipped when the binary/tmux is missing) and are a documented
follow-up, not a blocker. See
[`work/impl-phase-2.md`](work/impl-phase-2.md) (U4 + U5a),
[`work/impl-phase-3.md`](work/impl-phase-3.md) (U5b),
[`work/impl-phase-4.md`](work/impl-phase-4.md) (U6 core),
[`work/impl-phase-5.md`](work/impl-phase-5.md) (U7), and
[`work/impl-phase-6.md`](work/impl-phase-6.md) (round 6 coherence assertions)
for the exact landed-vs-remaining split.

The hard, net-new infra: a shared configurable instruction primitive, a single-step execution
mode, the host→CLI action channel, the interactive `failed` view wired end-to-end, and the
status-aware bare-resume fallback (which depends on the failed view existing for AT-11). This phase
**flips** `orch resume <failed-id>` from silent re-run to the interactive failure view.

#### Actioned side-effects matrix (the contract U5/U6/U8 must satisfy)

The pure-open path (U2) suppresses *all* side effects; once the user **acts**, mutation is
intentional but must be **coherent** (D6). The plan pins the observable boundaries below; exact
lifecycle-event *names* are an implementation choice, the observable on/off is not. "stays in TUI"
means the action does not drive process exit — a later `q` exits `0` (the un-actioned-quit purity of
AT-R4 no longer applies once acted, but the action's own write is the only mutation).

| Action / outcome | `status` after | run-lifecycle event | cmux pill | logs | process exit |
|---|---|---|---|---|---|
| `[r]` passes, parks (KTD-8) | stays `failed` | **no** `run:ended`; step's own retry attempt is logged | unchanged (`failed`) | new retry-attempt log for the step | stays in TUI → later `q` = `0` |
| `[r]` fails again | stays `failed` | **no** `run:ended`; back to failure view | unchanged (`failed`) | new failed retry-attempt log | stays in TUI → later `q` = `0` |
| `[c]` completes (AT-R3) | `completed` | `run:ended` fires (legit) | `failed → completed` (AT-R11) | continue-execution logs | `0` |
| `[c]` fails again | stays `failed` | **no** `run:ended`; re-park at failure view | unchanged (`failed`) | retry + partial logs | stays in TUI → later `q` = `0` |
| `orch retry` completes (headless, AT-R6/R8) | `completed` | `run:ended` fires | `failed → completed` | execution logs | `0` |
| `orch retry` fails again (headless, AT-R8) | stays `failed` | **no** `run:ended`; re-parked | unchanged (`failed`) | retry logs | non-zero |

Two consequences worth stating explicitly: (1) the only path that emits `run:ended` / flips the
cmux pill is a retry-and-continue reaching `completed` — every retry-only and fail-again outcome
leaves `status === 'failed'` and the pill untouched, which is what makes AT-R11 a *positive* inverse
of AT-16 rather than a contradiction; (2) a successful `[r]` *does* write (the step's attempt
state, KTD-8) — so it is not byte-for-byte pure like an un-actioned open, but it must not emit
run-lifecycle/cmux side effects, because the run has not reached a new terminal state.

### AI-implementable tasks

#### U4. Shared, configurable retry/continue instruction primitive

- **Goal:** Lift the hardcoded `RECOVERY_NUDGE = 'continue'` (`workflow.ts:1332`) into a
  `kind`-aware resolver seam threaded through `RecoveryLoopDeps`/`buildRecoveryCommand`, with the
  existing string as the built-in default for **both** kinds, reachable from the manual-retry path.
  This is the single instruction source (D7) for now. Per KTD-4: `[r]`/retry and `[c]`/continue are
  modelled as distinct *kinds* (both defaulting to `'continue'` until a config schema exists), and
  the **typed-override input UI is explicitly NOT built here** (sibling-owned; Non-goals).
- **Requirements:** D7; foundation for AT-R5. (Scope boundary: delivery of the configured/default
  instruction — *not* the sibling's config schema or override input box.)
- **Dependencies:** none (can land first in Phase 2).
- **Files:**
  - `src/core/recovery/loop.ts` — add an optional instruction-resolver field to `RecoveryLoopDeps`
    (default resolves `'continue'` for both kinds).
  - `src/core/workflow.ts` — `buildRecoveryCommand` accepts the resolved instruction instead of
    baking the constant; keep the constant as the default.
  - `src/core/recovery/instructions.ts` *(new)* — a tiny module holding the built-in default + a
    `resolveInstruction(kind, configured?)` helper (`kind ∈ {retry, continue}`), so the sibling can
    later point its schema here without re-threading the seam. Keep it minimal.
  - `tests/...` unit: default used for both kinds when nothing configured; a configured value for a
    kind overrides only that kind; retry vs continue can differ.
- **Approach:** Pure parameter-threading; no behavior change to the autonomous loop when the
  default is used (regression-guard that the loop still sends `'continue'`).
- **Patterns to follow:** the recovery-loop seam (`runRecoveryLoop` deps); Claude/Codex
  `forkResumeCommand` already accept the `nudge` argument — only the *source* of the nudge changes.
- **Test scenarios:**
  - Happy path. Given no configured instruction, when recovery/manual retry builds the command for
    either kind, then the built-in default `'continue'` is used — assert the value handed to
    `forkResumeCommand`.
  - Distinct kinds. Given a configured continue value distinct from the retry value, when each
    command is built, then the matching kind's instruction is passed (retry ≠ continue is
    representable).
  - Regression. Given the autonomous loop with nothing configured, then it still sends `'continue'`
    (no behavior change).

#### U5. Single-step execution mode + host→CLI action channel

- **Goal:** Two net-new primitives: (a) a **"run exactly one step then re-park"** executor mode for
  `[r]`; (b) a **third foreground-shutdown outcome** ("user action": `retry` / `retry-continue`)
  threaded from the Ink view through the host to the CLI, plus `[r]`/`[c]` keybindings and new
  `StepsViewIntent` variants. `[c]` reuses existing resume re-run semantics (KTD-5).
- **Requirements:** D3, D8 infra; foundation for AT-2, AT-3, AT-R1, AT-R2, AT-R3.
- **Dependencies:** U4.
- **Files:**
  - `src/hosts/two-pane/steps-view/step-types.ts` — extend `StepsViewIntent` with
    `{type:'retry'}` and `{type:'retry-continue'}`.
  - `src/hosts/two-pane/steps-view/steps-view.tsx` — bind `[r]`/`[c]` in `useInput` (only in the
    `failed` interactive variant; not in `completed`).
  - `src/hosts/host.ts` — widen `ForegroundShutdownReason` to include a user-action outcome
    (carrying which action).
  - `src/hosts/two-pane/tmux-host.ts` — resolve the shutdown deferred with the action (mirror the
    existing `'quit'` resolution in `composedIntent`).
  - `src/cli/commands/execute-with-attach.ts` — handle the third outcome (drive execution instead
    of tearing down).
  - `src/core/workflow.ts` — single-step execution entry (run one step against cache-replayed
    state, then stop, leaving the run re-parkable).
  - `tests/...` tmux-argv/unit for keymap + intent serialization; unit for single-step executor.
- **Approach:** The Ink view emits the new intents over the existing intent channel
  (`tui-intents.ndjson` → `StepsIntentSchema`). `awaitForegroundShutdown()` resolves with the
  action; the CLI open loop (U6) reacts. The single-step primitive runs the failed step via the
  normal step dispatch but returns control after one step rather than continuing the body.
- **Patterns to follow:** the existing `composedIntent`/`shutdownDeferred` resolution in
  `tmux-host.ts`; `StepsViewIntent` discriminated union; the recovery loop's per-attempt structure
  for single-attempt execution; outcome-via-file-sentinel idiom for interactive-step outcome (per
  `builtin-phased-build-workflows` learning — interactive autoStop steps exit `0` regardless).
- **Test scenarios:**
  - Happy path (keymap). Given the `failed` interactive view, when `[r]`/`[c]` are pressed, then
    the corresponding intent is emitted; pressing them in the `completed` view emits nothing
    (tmux-argv/unit, no real tmux).
  - Single-step executor. Given a cache-replayed `failed` run, when the single-step mode runs and the
    step passes, then exactly one step (the failed one) is invoked, control returns without running
    later steps, and the persisted state matches KTD-8 (step attempt-state flipped to success,
    run `status` still `failed`, no `run:ended`) — assert via runner-boundary invocation count + the
    on-disk step/run state.
  - Shutdown outcome. Given the action channel, when an action intent arrives, then
    `awaitForegroundShutdown()` resolves with that action (not `'quit'`) — unit on the host wrapper.
  - `Test expectation: integration-level retry outcomes are covered in U6` (this unit is the
    plumbing; end-to-end retry behavior is asserted where the pieces meet).

#### U6. Interactive `failed` open + retry/continue wired end-to-end

- **Goal:** Flip `orch resume <failed-id>` to **park** at the interactive failure view (no silent
  re-run). Footer adds `[r]`/`[c]` (completed does not). `[r]` re-invokes the failed step once via
  U5's single-step mode with U4's instruction (fork/session-resume per runner); pass → step
  persisted ok per KTD-8 (run `status` stays `failed`, step attempt-state flipped to success), run
  parked ready to continue; fail → back to the failure view. `[c]` retry-and-continue to
  completion. `⏎` inspect stays pure; un-actioned quit stays pure. Retry invalidates the per-step
  tee (KTD-6). Side effects follow the **actioned side-effects matrix** at the top of Phase 2.
  Successful continue fires the cmux pill `failed→completed`.
- **Requirements:** D2 (failed row), D3, D6 (failed half), D7; AT-2, AT-3, AT-R1, AT-R2, AT-R3,
  AT-R4, AT-R5, AT-R10, AT-R11, AT-18 (failed half), AT-19 (failed half), AT-20 (failed half).
- **Dependencies:** U1 (open container), U4, U5.
- **Files:**
  - `src/cli/commands/resume.ts` / `src/cli/commands/open-finished.ts` — `failed` branch opens the
    interactive container; an open loop reacts to the U5 action outcomes (retry single-step;
    retry-continue → resume re-run) and re-parks or completes.
  - `src/hosts/two-pane/steps-view/end-of-run-summary.tsx` — `failed` footer adds `[r]`/`[c]`
    affordances; `completed` footer unchanged.
  - `src/core/workflow.ts` — wire single-step retry to mark the step ok / re-park (KTD-8); `[c]` to
    the existing resume re-run. Expose retry-and-continue as a **host-free** core
    (`retryAndContinue(runId, instructionSource)`-shaped) so U8's headless branch can call it
    without constructing the two-pane host (Finding-4 seam).
  - per-step tee invalidation in the runner replay path (`src/runners/*` `toTranscriptLines` /
    `logs/agents/<step>/formatted_output.ansi`).
  - `tests/...` full-host scenarios (fake-agent, fail-then-pass / fail-again scripting), cmux pill
    assertions, before/after `state.json`/`logs/` for the un-actioned path, instruction-capture via
    a recording fake runner, two-sequential-invocation coherence.
- **Execution note:** Start with a failing full-host scenario for AT-2 (the failed open must park,
  not re-run) before wiring actions — it pins the behavior the old silent-re-run path violates.
- **Approach:** The failed open uses the same no-execution container as U1/U2 until the user acts.
  On `[r]`, run the single-step retry (U5) with the fork/session-resume primitive so the agent
  knows a prior attempt failed (Claude `--resume --fork-session`; Codex rollout-copy with the
  configured/overridable instruction). On `[c]`, drive the existing resume re-run to completion.
  Invalidate the step tee on retry so warm-cache `⏎` doesn't serve stale bytes.
- **Patterns to follow:** `forkResumeCommand` on each runner; `captureCodexThreadId` for Codex
  session-id capture (await `result` after spawn); the `autonomous-transcript-rendering` learning
  for tee invalidation; the un-actioned-open suppression from U2.
- **Test scenarios:**
  - Covers AT-2. Given a `failed` fixture + TTY, when `orch resume <failed-id>`, then the
    interactive failure view renders with retry/continue affordances exposed — **not** a read-only
    footer and **not** a silent re-run — assert via the left steps pane footer.
  - Covers AT-3. Given a `failed` view and a `completed` view, when comparing footers, then the
    failed footer adds `[r]`/`[c]` that completed lacks; both keep `⏎`/`q`.
  - Covers AT-R1. Given a `failed` run + fake runner scripted fail-then-pass, when `[r]`, then
    exactly that step is re-invoked once, marked ok, the run stays parked, the continue affordance
    is available, and no further steps run — assert runner boundary + rendered view.
  - Covers AT-R2. Given the failed step scripted to fail again, when `[r]`, then the view returns to
    the interactive failure state (retry again / continue / quit) with no manual-retry ceiling.
  - Covers AT-R3. Given the failed + remaining steps will succeed, when `[c]`, then the failed step
    re-runs and the workflow proceeds to the end — assert `state.json` `failed → completed`.
  - Covers AT-R4. Given a `failed` view, no action taken, `state.json`/`logs/` captured, when `q`,
    then the run is still `failed`, `state.json` byte-for-byte unchanged, no new logs, no `run:ended`
    re-emitted, exit `0`.
  - Covers AT-R5. Given a configured retry instruction, when `[r]`/`[c]`, then the agent receives
    that instruction and (where supported) the prior failed session is resumed/forked — assert via a
    fake runner recording the prompt/instruction handed in.
  - Covers AT-18/AT-19 (failed half). Given the failed view with a past interactive step, when
    `⏎`-inspect, then the replay shows in the right pane **and** `state.json` is unchanged across
    the inspect (only `[r]`/`[c]` mutate).
  - Covers AT-20 (failed half). Given no TTY + a `failed` run id, when `orch resume <id>`, then it
    refuses (status-named, non-zero) — it does **not** silently re-run the failed run.
  - Covers AT-R10. Given a `failed` run retried via `orch resume` (passing or failing-again) and the
    process exited, when a later `orch resume <same-id>`, then it loads cleanly (cache replay + tee
    coherent) and opens in the view matching its now-current status, no corruption error.
  - Covers AT-R10a *(plan-added, exercises the KTD-8 parked state directly — see Test strategy
    Finding-6 note)*. Given `[r]` succeeded and the user **quit before continuing**, when a later
    `orch resume <same-id>` runs, then the run loads with `status` still `failed`, re-opens the
    interactive failure view with the previously-failed step shown ok and `[c]` still offered, and
    **no step re-runs** until the user acts — assert the rendered view + runner-boundary zero
    invocations on the reopen + on-disk step state.
  - Covers AT-R11. Given a cmux-integrated env and a `[c]` that drives the run to `completed`, then
    the cmux pill transitions `failed→completed` (the positive inverse of AT-16).

#### U7. Status-aware bare-resume fallback (reusing `ConfirmService`)

- **Goal:** Bare `orch resume`: prefer a resumable (`crashed`/`running`) run and **never** offer a
  finished one when a resumable exists; else identify the newest finished run and confirm before
  opening, with the prompt **distinguishing** read-only (completed) vs interactive failure view
  (failed). Confirm → open in the matching view; decline → "nothing to resume".
- **Requirements:** D5; AT-9, AT-10, AT-11, AT-12.
- **Dependencies:** U1 (completed open), U6 (failed open — AT-11 opens failed in the interactive
  view), KTD-3.
- **Files:**
  - `src/cli/commands/resume.ts` — extend `findResumableRun`/bare-path: after the resumable scan
    misses, find the newest `completed`/`failed`, call `ConfirmService.confirm(...)` with
    status-distinguishing copy, branch into U1/U6 open on `y`, "nothing to resume" on `N`.
  - wire a `ConfirmService` into the resume deps (`ReadlineConfirmService` real,
    `FakeConfirmService` in tests).
  - `tests/...` lifecycle/TTY scenarios: confirm text per status; confirm-opens; decline-opens-
    nothing; resumable-preferred.
- **Approach:** Reuse the existing `ConfirmService` port (KTD-3); no new service. The prompt copy
  is planning-flexible but **must** name the run (id/workflow/status) and state the open kind.
- **Patterns to follow:** existing `findResumableRun` scan (`resume.ts:34`); `confirmSuffix`/
  `parseYesNo` helpers; `FakeConfirmService` scripting.
- **Test scenarios:**
  - Covers AT-9. Given both a resumable and finished runs, when bare `orch resume`, then the
    resumable run resumes for real and **no** finished-run confirmation is shown — assert progress +
    absence of prompt on stderr.
  - Covers AT-10. Given no resumable run, only finished runs, TTY, when bare `orch resume`, then a
    confirmation naming the newest finished run (id/workflow/status) is shown before anything opens,
    distinguishing **read-only** (completed) vs **interactive failure view (retry/continue
    available)** (failed) — assert the confirmation text.
  - Covers AT-11. Given the confirmation, when the user confirms (`y`), then the run opens in the
    matching view (read-only for completed, interactive for failed) and a clean quit exits `0`.
  - Covers AT-12. Given the confirmation, when the user declines (`N`/default), then nothing opens
    and the command reports "nothing to resume" — assert stderr, no TUI.

### Implementation choices (bounded by the contract, no user decision needed)

- **Final confirmation copy (D5).** The exact prompt wording is explicitly "planning's call" in the
  brainstorm; the implementer finalizes it. The contract fixes only the *status-distinguishing*
  requirement (name the run + state read-only vs interactive-failure-view); the brainstorm examples
  are acceptable defaults.

### Blocked-on-user-input

- None. Phase 2 is fully AI-implementable within the acceptance contract.

---

## Phase 3 — `orch retry <id>` verb

**Status: done** — U8 landed. `orch retry` is registered in `COMMANDS`
(`src/cli/commands/retry.ts` → `retryCmd`/`retryRun`). It shares `resume`'s
`resolveExplicitTarget` (now exported) for prefix/not-found resolution, then
status-gates: a `failed` run drives auto retry-and-continue through the pinned
host-free `runResumeExecution` seam (U6) with the U4 `defaultInstructionResolver`;
every non-`failed` status is rejected with a status-named, non-zero exit
(`EXIT.CANNOT_RESUME`, KTD-2 — no new error type needed since the rejection is a
direct CLI branch, not an executor throw). No TTY/headless branch was required:
`runResumeExecution` builds whatever host the factory resolves (two-pane on a
TTY → the user watches the retry; plain headless → runs to completion, never
blocks), and constructs no interactive failure view / action channel /
`ConfirmService`, so the headless path can neither hang nor refuse-by-copying-
`resume`. Integration-proven in
[`tests/integration/cli/commands/retry.test.ts`](../../../tests/integration/cli/commands/retry.test.ts)
(AT-R6/R7/R8/R9 + the AT-R10 cross-verb half). The residual is the same gated
real-CLI tail as Phase 2 (real-tmux rendered open for AT-R6; real fork/session-
resume instruction recording shared with AT-R5) — not new product code. See
[`work/impl-phase-7.md`](work/impl-phase-7.md). Public CLI docs
(`docs/public/reference/cli.md`) reconciled with the new verb and the corrected
`resume` behavior.

A thin verb on top of Phase 2's retry core: `orch resume <id>` + auto retry-and-continue, acting
only on `failed` runs.

### AI-implementable tasks

#### U8. `orch retry <id>` command

- **Goal:** Register `retry` in `COMMANDS` (`src/cli/main.ts`). On `failed`: open + auto-trigger
  retry-and-continue (the `[c]` path without a keypress) to completion. On `completed`/`crashed`/
  `running`: reject with a status-named message + non-zero exit (KTD-2) — never silently fall back
  to resume/read-only. Reuse `resume`'s prefix/not-found resolution. Headless `orch retry
  <failed-id>` runs the configured-default instruction, never blocks, and exits with a code
  reflecting the retry outcome.
- **Requirements:** D4, D8 (retry half); AT-R6, AT-R7, AT-R8, AT-R9, AT-R10 (cross-verb half).
- **Dependencies:** U6 (retry core), U4 (instruction).
- **Files:**
  - `src/cli/commands/retry.ts` *(new)* — `retryCmd(deps, positional, args, opts, hostFactory)`;
    load state, status-gate, drive the auto-continue path.
  - `src/cli/main.ts` — import + register `retry: retryCmd` in `COMMANDS`.
  - `src/core/errors.ts` — narrow/repurpose `ResumeError` (or add a small dedicated error) for the
    non-failed rejection; map to a non-zero exit (KTD-2).
  - `tests/...` real `orch retry` scenarios: failed auto-continue; non-failed rejection (×3
    statuses); headless runs-default; prefix resolution; cross-verb coherence.
- **Approach:** `retryCmd` shares `resume`'s id-resolution, then status-gates, then branches by TTY
  — the two branches must **not** share a code path that requires the TUI:
  - **TTY:** optionally attach/open and programmatically trigger the same retry-and-continue core as
    `[c]`.
  - **No TTY:** call the host-free retry-and-continue **core directly** — no two-pane host, no
    host→CLI action channel, no `ConfirmService`, no typed-override UI, no `awaitForegroundShutdown`
    outcome plumbing. This is the contract of D8/AT-R8 (never block, never refuse-by-copying-`resume`,
    never construct a TUI just to tear it down). It uses the U4 configured-default instruction.

  This requires the retry-and-continue core (U6, `[c]` ≈ `executor.resume()` re-run per KTD-5) to be
  exposed as a callable `retryAndContinue(runId, instructionSource)`-shaped function independent of
  the host — pin that seam in U6 so U8's headless branch has something host-free to call.
- **Patterns to follow:** `resumeCmd` structure + prefix resolution (`resume.ts`); `COMMANDS`
  registration shape (`main.ts:382`); `mapResumeError`/exit-code mapping; the no-TTY detection in U3
  (but U8 **acts** instead of refusing).
- **Test scenarios:**
  - Covers AT-R6. Given a `failed` run + TTY, when `orch retry <failed-id>`, then the run opens and
    retry-and-continue fires automatically (no manual `[c]`); the failed step re-runs and the
    workflow proceeds to completion — assert runner boundary + `state.json` advancing toward
    `completed`.
  - Covers AT-R7. Given a `completed` run (and, separately, `crashed` and `running`), when `orch
    retry <id>`, then it does not retry/open; it reports retry applies only to failed runs (naming
    the actual status) and exits non-zero — assert stderr + exit code (×3 statuses).
  - Covers AT-R8. Given no TTY + a `failed` run, when `orch retry <failed-id>`, then retry-and-
    continue runs using the configured default (no override prompt, no hang) and the exit code
    reflects the outcome (success vs failed-again) — assert stderr + exit code.
  - Covers AT-R8 (no-host guard). Given the no-TTY path, when `orch retry <failed-id>` runs, then it
    drives the host-free `retryAndContinue` core and **never instantiates** the two-pane host or the
    prompt/confirm service — assert via spies/construction counters on the host factory and
    `ConfirmService` (guards against a CI hang or a copied-`resume` no-TTY refusal).
  - Covers AT-R9. Given a prefix matching more than one run (and, separately, none), when `orch
    retry <prefix>`, then ambiguous-prefix / not-found handling matches `resume`'s existing path.
  - Covers AT-R10 (cross-verb half). Given a `failed` run retried via `orch retry`, when a later
    `orch resume`/`orch retry` runs, then the run loads cleanly and opens in the correct view
    without corruption.

### Implementation choices (bounded by the contract, no user decision needed)

- **`ResumeError` rename vs reuse (open Q1).** KTD-2 fixes the *contract* (non-zero + status-named
  rejection, no "cannot resume" for normal finished runs); whether to rename the error type or
  reuse it is a cosmetic implementer choice.

### Blocked-on-user-input

- None. Phase 3 is fully AI-implementable within the acceptance contract.

---

## Test strategy & shared fixtures

Per [`CLAUDE.md`](../../../CLAUDE.md) and the feasibility appendix, drive a **real** `orch
resume`/`orch retry` against a `FakeRunner` and assert the **external** outcome (full-host
`fake-agent` scenarios, exit codes, stderr, on-disk `state.json`/`logs/`, runner boundary), not
unit-poked components.

- **New shared test infra (lands with U1, reused throughout):** a **finished-run fixture builder**
  that writes a pre-finished `.orch/state/<runId>/` (completed / failed / crashed) without
  executing, plus a scenario `LaunchSpec` that opens a pre-finished fixture. The feasibility
  appendix flags this as the gating infra for AT-1/AT-2.
- **Fake runner scripting:** fail-then-pass and fail-again scripting for U6 (AT-R1/AT-R2); a
  prompt-recording fake for AT-R5.
- **Plan-added scenarios beyond the AT-IDs (do not edit `acceptance-tests.md`):**
  - **AT-R10a — retry-only success → quit → reopen** (owned by U6). Exercises the KTD-8 parked state
    that AT-R1 *creates* but no AT directly re-opens: `[r]` passes, the user quits before `[c]`, and a
    later `orch resume <same-id>` re-opens the failed interactive view (status still `failed`, step
    shown ok, `[c]` offered, nothing re-runs). AT-R10 only covers "passing or failing-again then
    reload", not the quit-before-continue case — so this closes a real gap.
- **Scope note on the typed-override (D7).** AT-R5 covers *delivery of the configured/default
  instruction* on `[r]`/`[c]`/`orch retry`, which this feature owns and tests. D7's interactive
  *typed-override input* rides on the sibling's unbuilt config/override TUI (brainstorm Non-goals
  defer the instruction schema) and is **deliberately not implemented or tested here** (KTD-4). The
  coverage map below is exhaustive for the AT contract; it does **not** claim to implement the
  sibling-owned override surface.
- **Hygiene (from learnings):** gate cmux-touching subprocess tests with `ORCH_DISABLE_CMUX`; build
  spawn env via `mergeEnv` and assert `PATH` for cross-runner resume; pin `cwd` + reset the reader
  in any `promptFile`-touching test; ensure any new fake/puppet self-reaps on parent death; never
  `pkill` the `bun test` runner.
- **Gate:** every phase lands green under `bun run check`; the gated real-CLI levels
  (`bun run check:release`) cover the Claude/Codex parity tests (auto-skipped when the CLI is
  missing).

### Acceptance-test → unit map (full coverage)

| Unit | ATs owned |
|---|---|
| U1 | AT-1, AT-4, AT-5, AT-6 (completed), AT-18 (completed) |
| U2 | AT-14, AT-15, AT-16, AT-17 (completed), AT-19 (completed) |
| U3 | AT-6, AT-7, AT-8, AT-13, AT-20 (completed), AT-21 (completed), AT-22 |
| U4 | (foundation for AT-R5) |
| U5 | (infra for AT-2, AT-3, AT-R1, AT-R2, AT-R3) |
| U6 | AT-2, AT-3, AT-18 (failed), AT-19 (failed), AT-20 (failed), AT-R1, AT-R2, AT-R3, AT-R4, AT-R5, AT-R10, AT-R10a *(plan-added)*, AT-R11 |
| U7 | AT-9, AT-10, AT-11, AT-12 |
| U8 | AT-R6, AT-R7, AT-R8, AT-R9, AT-R10 (cross-verb) |

All 22 AT-N and 11 AT-R behaviors are owned by exactly one unit (cross-status behaviors split their
completed/failed halves across the owning phase units), plus the plan-added AT-R10a (KTD-8 parked
state). The sibling-owned typed-override (D7) is explicitly out of scope and unmapped — see the
Test-strategy scope note.

---

## Risks & mitigations

- **Codex session-id capture parity (brainstorm open Q, feasibility item 3).** Codex mints its
  session id post-spawn (~9s lag on 0.130); capture can return `ambiguous`/`empty`/`error`.
  *Mitigation:* await `captureHandle.result` after spawn before forking; on capture failure, degrade
  to resume-in-place (the established no-stacking discipline) and surface
  `sessionIdCaptureError`; validate in a gated real-CLI test. This is a known, handled seam, not a
  blocker.
- **Cache/tee staleness after retry (KTD-6).** Forgetting tee invalidation makes a later `⏎`/resume
  replay pre-retry bytes. *Mitigation:* invalidate/rewrite `formatted_output.ansi` on retry; assert
  AT-R10 across two sequential invocations for both runners.
- **cmux teardown coupling (KTD-1, `cmux-run-end-bound-to-teardown` learning).** If `notifyRunEnd`
  fires on the open path's teardown, it clears the completed pill. *Mitigation:* no-op cmux host +
  no `beforeTeardown` hook on the pure open; AT-16 asserts no pill change, AT-R11 asserts the
  intended `failed→completed` only on a real continue.
- **Phase-1/Phase-2 interim inconsistency.** Between phases, `orch resume <failed-id>` still
  re-runs. *Mitigation:* accept as a documented interim (Phase 1 explicitly does not touch the
  failed path); the regression suite (U3) guards the unchanged statuses so the flip in U6 is the
  only behavior change.

---

## Assumptions

- **A1 — This feature builds the shared retry-instruction seam; the sibling consumes it (D7).** The
  sibling in-TUI feature is unbuilt. The brainstorm permits a built-in default when nothing is
  configured, and the codebase already has a hardcoded `'continue'` nudge. KTD-4 lifts that into a
  shared, parameterizable seam with the default. When the sibling lands its richer per-step/workflow
  schema, it points at the same seam — it does not require re-architecting this feature. If the
  reviewer intends the sibling to land **first** and own the seam, flag it; otherwise this feature
  owns it.
- **A2 — Parallel-step retry granularity follows today's resume semantics (KTD-7).** `[r]`/`[c]` on
  a `ParallelError` re-run at the same granularity `executor.resume()` uses today (whole block via
  cache-replay). Brainstorm open Q2 leaves this open and shared with the sibling; this is the
  conservative default.
- **A3 — `ResumeError` is narrowed/reused, not removed (KTD-2, open Q1).** The completed guard stays
  as a backstop; the user-facing "cannot resume" message is unreachable for normal finished runs.

*(Headless plan-write: the above are inferred bets surfaced as assumptions per the planning
workflow; confirm A1's ownership question with the reviewer before Phase 2 if the sibling is
expected to land first.)*
