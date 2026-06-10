# Acceptance Tests — Re-open a finished run from the CLI (`resume` + `retry`)

> High-level **behavioral acceptance criteria** for re-opening a finished run via `orch resume` /
> `orch retry`, derived from [brainstorm.md](brainstorm.md) (v2 redesign). Each is meant to become
> a real, executing test. They describe behavior, not implementation — read them to know the
> feature works without reading the code. Track implementation by AT-ID in the status table.
>
> Scope note: this sidecar covers the **CLI re-entry** feature — `orch resume` into a read-only
> completed view or an interactive failed view, and the new `orch retry` verb. The sibling
> [in-tui-failure-resume-brainstorm.md](in-tui-failure-resume-brainstorm.md) (stay-in-TUI at the
> *live* failure moment) is a **separate feature**, intentionally out of scope here — but the two
> share the `'failed'` view, the `[r]`/`[c]` action semantics, and the configured retry/continue
> instruction source.
>
> **What changed in v2 (vs the original "open completed/failed read-only"):**
> - `orch resume <failed-id>` no longer opens *read-only*; it opens an **interactive failure
>   view** where the user chooses retry / retry-and-continue / quit. (Today it silently re-runs;
>   the v1 "read-only" framing would have removed a real capability — see
>   [doc-review.md](doc-review.md).)
> - The "read-only means read-only" guarantees (AT-14–AT-17, AT-19) are **re-scoped**: they hold
>   for **completed** runs and for a **failed run opened-but-not-actioned**, but *not* for a failed
>   run that has been retried (which mutates by design).
> - New `orch retry <id>` verb (= `resume` + auto retry-and-continue) and its tests (AT-R*).
>
> **Resolved decisions carried into these tests:**
> - `orch retry <id>` = **retry-and-continue** to completion (not retry-only-and-park).
> - **Headless diverges by verb:** no-TTY `orch resume <finished-id>` **refuses**; no-TTY `orch
>   retry <failed-id>` **runs** the configured-default retry, never blocks.
> - `orch retry` on a non-`failed` run is **rejected** (status-named message, non-zero exit).
>
> The read-only/observation negatives are each written so the open / inspect must **succeed first**
> (a positive precondition: viewer shown, clean quit, or replay shown) before the negative is
> asserted — so the test cannot pass vacuously against an unwired feature where `resume` still
> errors or silently re-runs.

## Tests — `orch resume` (completed, read-only)

### AT-1 — A completed run opens in the read-only end-of-run viewer
- **Given** a finished run whose status is `completed`, and an interactive terminal
- **When** the user runs `orch resume <completed-run-id>`
- **Then** the existing read-only end-of-run view is shown for that run (its completed summary, with the quit affordance) rather than any error
- **Observable through** a real `orch resume` invocation + the rendered two-pane TUI (left steps pane)

### AT-4 — Quitting the completed read-only viewer exits cleanly
- **Given** the read-only viewer is open for a `completed` run
- **When** the user quits the viewer (`q`)
- **Then** the command exits with code `0`
- **Observable through** a real `orch resume` invocation + the process exit code

### AT-5 — Opening a completed run read-only runs none of its steps
- **Given** a `completed` run with one or more agent steps
- **When** the user opens it read-only via `orch resume <completed-id>`
- **Then** no workflow step executes — no agent/runner is invoked for that open
- **Observable through** a real `orch resume` against a run backed by a fake runner + the runner boundary (the runner is never asked to run a step)

### AT-6 — A normal finished run never reports "cannot resume"
- **Given** a run whose status is `completed` (or `failed`)
- **When** the user runs `orch resume <run-id>`
- **Then** the command never prints the "cannot resume" message and never exits with the `CANNOT_RESUME` code for that run
- **Observable through** a real `orch resume` invocation + its stderr and exit code

### AT-18 — Inspecting a past interactive step shows its replay
- **Given** the viewer is open for a finished run (completed read-only, or the failed interactive view) that has a past interactive step
- **When** the user inspects/replays that step (the existing `⏎` behavior)
- **Then** the step's replay is shown in the right pane
- **Observable through** a real `orch resume` invocation + the rendered right pane (replay)

### AT-19 — Inspecting a past interactive step mutates nothing (both views)
- **Given** a past interactive step has been inspected/replayed (per AT-18) — in the completed read-only view **and** in the failed interactive view — with `state.json` captured before the inspect
- **When** that inspect completes
- **Then** the run's persisted `.orch/state/<runId>/state.json` is unchanged (in the failed view, `⏎`-inspect is pure; only `[r]`/`[c]` mutate)
- **Observable through** a real `orch resume` invocation + a before/after read of `state.json` on disk

## Tests — `orch resume` (failed, interactive)

### AT-2 — A failed run opens in the interactive failure view
- **Given** a finished run whose status is `failed`, and an interactive terminal
- **When** the user runs `orch resume <failed-run-id>`
- **Then** the interactive failure view (the `failed` variant) is shown with the retry / retry-and-continue / quit affordances exposed — **not** a read-only footer and **not** a silent re-run
- **Observable through** a real `orch resume` invocation + the rendered two-pane TUI (left steps pane footer)

### AT-3 — The failed view exposes retry/continue affordances the completed view lacks
- **Given** a `failed` run open in the interactive failure view, and a `completed` run open read-only
- **When** the user looks at the footer affordances of each
- **Then** the failed footer **adds** the `[r]` retry and `[c]` retry-and-continue affordances that the completed view intentionally does not offer; both still expose inspect (`⏎`) and quit (`q`)
- **Observable through** real `orch resume` invocations + the rendered footers of both views

### AT-R1 — Retrying the failed step, and it passes, leaves the run parked ready to continue
- **Given** a `failed` run open in the interactive failure view, backed by a fake runner scripted so the failed step now succeeds
- **When** the user triggers `[r]` retry-the-step
- **Then** exactly that step is re-invoked once, it is marked ok, the run **stays parked** (not torn down), the continue affordance is available, and no further steps run yet
- **Observable through** a real `orch resume` invocation + the runner boundary (one re-invocation of the failed step) + the rendered view

### AT-R2 — Retrying the failed step, and it fails again, returns to the failure view
- **Given** a `failed` run open in the interactive failure view, backed by a fake runner scripted to fail the step again
- **When** the user triggers `[r]` retry-the-step
- **Then** the view returns to the interactive failure state, where the user may retry again, continue, or quit (no manual-retry ceiling)
- **Observable through** a real `orch resume` invocation + the rendered view

### AT-R3 — Retry-and-continue runs the workflow to completion
- **Given** a `failed` run open in the interactive failure view whose failed step and remaining steps will succeed
- **When** the user triggers `[c]` retry-and-continue
- **Then** the failed step is re-run and the workflow proceeds through to the end, ending `completed`
- **Observable through** a real `orch resume` invocation + persisted `state.json` status advancing `failed → completed`

### AT-R4 — Quitting an unactioned failed view leaves the run failed and mutates nothing
- **Given** a `failed` run open in the interactive failure view, with the user having taken **no** retry/continue action, and `state.json`/`logs/` captured before the open
- **When** the user quits (`q`)
- **Then** the run is still `failed`, `state.json` is byte-for-byte unchanged, no new logs were written, no `run:ended` was re-emitted, and the command exits `0` (observation, not action)
- **Observable through** a real `orch resume` invocation (open → quit) + before/after reads of `state.json` and `logs/` + the exit code

### AT-R5 — The agent is told it is a retry, using the configured instruction
- **Given** a `failed` run open in the interactive failure view, with a configured retry instruction
- **When** the user triggers `[r]`/`[c]`
- **Then** the agent receives the configured retry/continue instruction (and, where the runner supports it, the prior failed session is resumed/forked so the agent is aware a prior attempt failed) — the same instruction source the sibling feature uses
- **Observable through** a real `orch resume` invocation against a fake runner that records the instruction/prompt it was handed

## Tests — `orch retry`

### AT-R6 — `orch retry <failed-id>` opens and auto-triggers retry-and-continue
- **Given** a run whose status is `failed`, and an interactive terminal
- **When** the user runs `orch retry <failed-run-id>`
- **Then** the run opens and the retry-and-continue action fires automatically (no manual `[c]` keypress) — the failed step is re-run and the workflow proceeds to completion
- **Observable through** a real `orch retry` invocation + the runner boundary (failed step re-invoked) + `state.json` advancing toward `completed`

### AT-R7 — `orch retry` on a non-failed run is rejected with a clear message
- **Given** a run whose status is `completed` (and, separately, `crashed` and `running`)
- **When** the user runs `orch retry <id>`
- **Then** the command does not retry or open; it reports that retry applies only to failed runs (naming the run's actual status) and exits non-zero — it does not silently fall back to resume/read-only
- **Observable through** a real `orch retry` invocation + stderr + exit code

### AT-R8 — Headless `orch retry <failed-id>` runs the configured default and never blocks
- **Given** no interactive terminal (stdin/stdout piped / CI), and a `failed` run
- **When** the user runs `orch retry <failed-run-id>`
- **Then** the retry-and-continue runs using the **configured-default** instruction (no override prompt, no hang), and the command exits with a code reflecting the retry outcome (success vs failed-again)
- **Observable through** a real `orch retry` invocation with no TTY + stderr + exit code

### AT-R9 — `orch retry` reuses prefix resolution (ambiguous + not-found)
- **Given** a run-ID prefix matching more than one run (and, separately, a prefix matching none)
- **When** the user runs `orch retry <prefix>`
- **Then** ambiguous-prefix / not-found handling matches `orch resume`'s existing path, unchanged
- **Observable through** a real `orch retry` invocation + stderr + exit code

### AT-R10 — After a CLI retry, a subsequent `orch resume`/`orch retry` still works (state coherence)
- **Given** a `failed` run was retried via `orch retry` / `orch resume` (passing or failing-again) and the process exited
- **When** the user later runs `orch resume <same-id>` (or `orch retry` again)
- **Then** the run loads cleanly — cache replay is intact, step attempt/recovery state is coherent — and opens in the view matching its now-current status, without a load/corruption error
- **Observable through** two sequential real invocations + the second rendering the correct view without error

## Tests — bare `orch resume` (auto-discovery + fallback)

### AT-7 — A crashed run still resumes for real (regression)
- **Given** a run whose status is `crashed`
- **When** the user runs `orch resume <crashed-run-id>`
- **Then** the run continues executing exactly as before this feature (it is not opened read-only or parked)
- **Observable through** a real `orch resume` invocation + the run's persisted state advancing past where it crashed

### AT-8 — A running run still resumes for real (regression)
- **Given** a run whose status is `running`
- **When** the user runs `orch resume <running-run-id>`
- **Then** the run resumes and continues executing exactly as before this feature
- **Observable through** a real `orch resume` invocation + the run's persisted state progressing to completion

### AT-9 — Bare resume prefers a resumable run and never offers a finished one
- **Given** both a resumable run (`crashed`/`running`) and one or more finished runs exist
- **When** the user runs bare `orch resume` (no run ID)
- **Then** the resumable run is resumed for real and no confirmation to open a finished run is shown
- **Observable through** a real bare `orch resume` invocation + the resumed run progressing (and absence of any finished-run prompt on stderr)

### AT-10 — Bare resume with only finished runs asks before opening the newest, and names the open kind
- **Given** no resumable run exists, only finished (`completed`/`failed`) runs, and an interactive terminal
- **When** the user runs bare `orch resume`
- **Then** a confirmation that names the most recent finished run (id/workflow/status) is shown before anything is opened, and the prompt distinguishes the open kind — **read-only** for a completed run vs the **interactive failure view (retry/continue available)** for a failed run
- **Observable through** a real bare `orch resume` invocation + the confirmation text presented to the user

### AT-11 — Confirming the fallback opens the newest finished run in the right view
- **Given** the bare-resume confirmation for the newest finished run is shown
- **When** the user confirms (`y`)
- **Then** that run opens in the view matching its status (read-only for `completed`, interactive failure view for `failed`) and, on a clean quit, exits `0`
- **Observable through** a real bare `orch resume` invocation + the rendered TUI and the process exit code

### AT-12 — Declining the fallback opens nothing
- **Given** the bare-resume confirmation for the newest finished run is shown
- **When** the user declines (`N`/default)
- **Then** nothing is opened and the command reports there was nothing to resume
- **Observable through** a real bare `orch resume` invocation + its stderr (no TUI is rendered)

### AT-13 — Bare resume with no runs at all is unchanged (regression)
- **Given** no runs exist at all
- **When** the user runs bare `orch resume`
- **Then** the existing "no resumable run found" behavior occurs, unchanged by this feature
- **Observable through** a real bare `orch resume` invocation + its stderr and exit code

## Tests — read-only/observation guarantees (scoped) and headless

### AT-14 — Persisted state byte-for-byte unchanged after an un-actioned open
- **Given** a finished run successfully opened and cleanly quit **without acting** — a `completed` run (AT-1/AT-4), or a `failed` run opened-but-not-actioned (AT-2 then `q`, AT-R4) — with its `state.json` captured before the open
- **When** that open-then-quit completes
- **Then** that run's `.orch/state/<runId>/state.json` is identical before and after (its `status`/`endedAt` unchanged). *(Does not apply to a failed run that was retried — that mutates by design; see AT-R3/AT-R10.)*
- **Observable through** a real `orch resume` invocation (open then quit) + a before/after read of `state.json` on disk

### AT-15 — No run-lifecycle events re-emitted by an un-actioned open
- **Given** a finished run successfully opened and cleanly quit **without acting** (completed, or failed-opened-but-not-actioned)
- **When** that open-then-quit completes
- **Then** no `run:ended` (or other run-lifecycle) event was emitted by the open. *(A retry/continue intentionally emits lifecycle events — see AT-R3.)*
- **Observable through** a real `orch resume` invocation (open then quit) + a lifecycle-event consumer attached to the run (a deliberate internal seam — AT-16 covers the externally-visible cmux consumer)

### AT-16 — No cmux side effects from an un-actioned open
- **Given** a finished run successfully opened and cleanly quit **without acting** in a cmux-integrated environment
- **When** that open-then-quit completes
- **Then** no cmux side effects fired — no notification, and no status pill cleared/set/changed. *(A successful retry-and-continue legitimately updates the pill `failed → completed` — see AT-R11; that is not a violation of this test, which is about an un-actioned open.)*
- **Observable through** a real `orch resume` invocation (open then quit) + the cmux surface (notifications and pills via the cmux host)

### AT-17 — No new run logs written by an un-actioned open
- **Given** a finished run successfully opened and cleanly quit **without acting**, with its `.orch/state/<runId>/logs/` captured before the open
- **When** that open-then-quit completes
- **Then** no new run log entries were written as if execution had happened. *(A retry writes new logs by design.)*
- **Observable through** a real `orch resume` invocation (open then quit) + a before/after read of the run's `logs/` directory

### AT-R11 — A successful retry-and-continue updates the cmux pill failed→completed (positive side effect)
- **Given** a `failed` run open in the interactive failure view in a cmux-integrated env, whose retry-and-continue will drive it to `completed`
- **When** the user triggers `[c]` retry-and-continue and it reaches `completed`
- **Then** the cmux status pill transitions to completed — side effects **do** fire here (the inverse of AT-16; guards against over-applying the un-actioned-open guarantee to the retried path)
- **Observable through** a real `orch resume` invocation + the cmux host surface

### AT-20 — With no terminal, an explicit finished-run ID to `resume` refuses with a clear error
- **Given** no interactive terminal (output piped / CI), and a finished (`completed`/`failed`) run id
- **When** the user runs `orch resume <finished-run-id>`
- **Then** the command refuses, prints a clear message naming the run and its status, and exits non-zero — it neither opens a TUI, nor hangs, nor silently re-runs a failed run. *(To act headlessly on a failed run, the user runs `orch retry` — AT-R8.)*
- **Observable through** a real `orch resume` invocation with no TTY + its stderr and exit code

### AT-21 — With no terminal, bare resume with only finished runs is "nothing to resume"
- **Given** no interactive terminal, no resumable run, and only finished runs exist
- **When** the user runs bare `orch resume`
- **Then** the command behaves as today's "no resumable run found" — it does not auto-open or auto-retry any finished run and exits non-zero — without ever prompting
- **Observable through** a real bare `orch resume` invocation with no TTY + its stderr and exit code

### AT-22 — An ambiguous run-ID prefix is handled by the existing path (regression)
- **Given** a run-ID prefix that matches more than one run (including finished runs)
- **When** the user runs `orch resume <ambiguous-prefix>`
- **Then** the existing ambiguous-prefix handling applies, unchanged by this feature
- **Observable through** a real `orch resume` invocation + its stderr and exit code

## Status

| ID    | Behavior                                                              | Status | Test file | Notes |
| ----- | --------------------------------------------------------------------- | ------ | --------- | ----- |
| AT-1  | Completed run opens read-only viewer                                  | ✅ routing + 🟡 rendering | resume-finished.test.ts (routing) + integration/real-tmux/end-of-run.test.ts (rendering) | Phase 1; Group 6/H1 hardened the routing half. The integration test now asserts the viewer's foreground **attached** + zero step execution (behavior), not the `read-only view` stderr literal a viewer rendering nothing would also print. The rendered terminal-view assertion is the gated real-tmux test (pre-finished `completed` state.json). |
| AT-2  | Failed run opens the **interactive failure view** (revised)           | 🟡 partial | open-failed.test.ts | Phase 2/U6: real `orch resume <failed>` now ROUTES to the interactive open + PARKS (no silent re-run) — integration-proven; the rendered-footer assertion via real tmux is full-host (footer affordances are model-covered in failure-actions--retry-keymap.test.tsx) and pending. |
| AT-3  | Failed footer adds retry/continue the completed view lacks (revised)  | 🟡 partial | failure-actions--retry-keymap.test.tsx | Phase 2/U5b: footer adds `[r]`/`[c]` (model-covered); the real-`orch resume` rendered comparison is full-host and pending. |
| AT-4  | Quitting the completed viewer exits 0                                 | ✅ implemented | open-finished.test.ts | Phase 1 |
| AT-5  | Completed read-only open runs no steps                                | ✅ implemented | open-finished.test.ts | Phase 1 |
| AT-6  | Never reports "cannot resume" for a finished run                      | ✅ implemented | resume-finished.test.ts + open-failed.test.ts | Both halves: completed (Phase 1) + failed no-TTY refuses with CONFIG_ERROR, not CANNOT_RESUME (Phase 2/U6) |
| AT-7  | Crashed run still resumes for real (regression)                       | ✅ implemented | resume-finished.test.ts | Phase 1 — guards the new branch does not divert crashed |
| AT-8  | Running run still resumes for real (regression)                       | ✅ implemented | resume-finished.test.ts | Phase 1 — guards the new branch does not divert running |
| AT-9  | Bare resume prefers resumable, never offers finished                  | ✅ implemented | bare-resume-fallback.test.ts | Phase 2/U7: resumable run takes the real resume path; `ConfirmService` recorded zero calls, no prompt on stderr |
| AT-10 | Bare resume (finished only) asks + names open kind (revised)          | ✅ implemented | bare-resume-fallback.test.ts | Phase 2/U7: confirm copy names run id/workflow/status and distinguishes read-only (completed) vs "interactive failure view (retry/continue available)" (failed) |
| AT-11 | Confirming fallback opens newest in the right view, exit 0 (revised)  | 🟡 partial | bare-resume-fallback.test.ts | Phase 2/U7: confirm→completed opens the read-only viewer, exit 0 (proven). The failed half routes to the same `openFailed` loop proven in open-failed.test.ts; bare→failed end-to-end open needs a real workflow on disk (gated full-host), pending |
| AT-12 | Declining the fallback opens nothing                                  | ✅ implemented | bare-resume-fallback.test.ts | Phase 2/U7: decline → "Nothing to resume.", exit 0, host factory never reached |
| AT-13 | Bare resume with no runs unchanged (regression)                       | ✅ implemented | integration/cli/commands/resume.test.ts | Phase 1 (pre-existing guard, unchanged) |
| AT-14 | State.json unchanged after an **un-actioned** open (re-scoped)        | ✅ implemented | open-finished.test.ts | Phase 1 (completed half; failed half Phase 2) |
| AT-15 | No run-lifecycle events from an **un-actioned** open (re-scoped)      | ✅ implemented | open-finished.test.ts | Phase 1 (completed half; zero logger appends) |
| AT-16 | No cmux side effects from an **un-actioned** open (re-scoped)         | ✅ implemented | open-finished.test.ts | Phase 1 (completed half; zero cmux spawns) |
| AT-17 | No new run logs from an **un-actioned** open (re-scoped)              | ✅ implemented | open-finished.test.ts | Phase 1 (completed half; zero logger writes) |
| AT-18 | Inspecting a past step shows its replay (both views)                  | ⬜ todo |           | Phase 1 viewer reachable; ⏎-inspect-in-read-only-view not yet exercised by a test (right-pane replay is pre-existing). |
| AT-19 | Inspecting a past step mutates nothing (both views)                   | ⬜ todo |           | See AT-18 note |
| AT-20 | No terminal + explicit `resume` ID refuses with a clear error         | ✅ implemented | resume-finished.test.ts + open-failed.test.ts | Both halves: completed (Phase 1) + failed (Phase 2/U6 — no-TTY refuses, never silently re-runs; runner boundary + state unchanged asserted) |
| AT-21 | No terminal + bare resume is "nothing to resume"                      | ✅ implemented | resume-finished.test.ts | Phase 1 |
| AT-22 | Ambiguous prefix handled by existing path (regression)               | ✅ implemented | integration/cli/commands/resume.test.ts | Phase 1 (pre-existing guard, unchanged) |
| AT-R1 | `[r]` retry passes → step ok, run parked ready to continue            | ✅ implemented | open-failed.test.ts | Phase 2/U6: real `openFailed` loop + FakeRunner fail-then-pass; runner boundary (one re-invocation) + on-disk step/run state (status stays failed, step2 ok, step3 unrun) |
| AT-R2 | `[r]` retry fails again → back to the failure view                    | ✅ implemented | open-failed.test.ts | Phase 2/U6: fail-again script; loop reopens the view, run stays failed |
| AT-R3 | `[c]` retry-and-continue runs to completion                           | ✅ implemented | open-failed.test.ts | Phase 2/U6: `[c]` → shared resume execution; `state.json` advances `failed → completed` |
| AT-R4 | Quitting an un-actioned failed view leaves it failed, mutates nothing | ✅ implemented | open-failed.test.ts | Phase 2/U6: un-actioned quit → exit 0, byte-for-byte `state.json` unchanged, runner boundary untouched (no executor on the view path) |
| AT-R5 | Agent told it is a retry, via the configured instruction              | 🟡 partial |           | Phase 2/U6: the U4 `instructionResolver` is wired through `[r]`/`[c]` (default delivers `'continue'`); a prompt-recording assertion + real-runner fork/session-resume is gated real-CLI, pending |
| AT-R6 | `orch retry <failed-id>` opens + auto retry-and-continue              | ✅ implemented | retry.test.ts | Phase 3/U8: real `retryRun` over `FileStateStore` + `FakeRunner` drives the failed step + continues; `state.json` advances `failed → completed`, no keypress. The on-TTY *rendered* open is the same gated full-host concern as AT-2. |
| AT-R7 | `orch retry` on a non-failed run is rejected                          | ✅ implemented | retry.test.ts | Phase 3/U8: `completed`/`crashed`/`running` each rejected — status-named message, non-zero exit, host factory never reached (throwing factory proves no open). |
| AT-R8 | Headless `orch retry <failed-id>` runs default, never blocks          | ✅ implemented | retry.test.ts | Phase 3/U8: plain-mode `retryRun` runs the U4 default instruction to completion; exit reflects outcome (success → 0, failed-again → non-zero); `ConfirmService` recorded **zero** calls (no override prompt, no hang). Real fork/session-resume instruction recording is gated (shared with AT-R5). |
| AT-R9 | `orch retry` reuses prefix resolution (ambiguous + not-found)         | ✅ implemented | retry.test.ts | Phase 3/U8: `retryCmd` shares `resume`'s `resolveExplicitTarget` — ambiguous prefix + not-found both exit non-zero with the same messages as `resume`. |
| AT-R10| State coherent after a CLI retry; later resume/retry still works      | 🟡 partial | open-failed.test.ts + retry.test.ts | Phase 2/U6 + Phase 3/U8; Group 6/H2 hardened the reopen half. The `[c]→completed` and `orch retry→completed` reopens now drive the **real `resumeCmd`** — which re-loads the now-`completed` state from disk and *decides* the read-only branch (asserted via the `(completed) … read-only view` routing banner + untouched runner) — instead of calling `openFinished` with a hand-passed `status`. **AT-R10a** (`[r]`-pass → quit → reopen the parked failed view) reopens with `status` still `failed`, step shown ok, zero re-runs (+ Group 1's projector assertion). Cross-runner tee coherence + reopen via real `orch resume` prefix routing over real tmux is gated real-CLI, pending. |
| AT-R11| Successful retry-and-continue updates cmux pill failed→completed      | ⬜ todo |           | new   |

Legend: ⬜ todo · 🟡 partial (behavior landed; full observable assertion pending — see Notes) · ✅ implemented · 🚫 won't implement (reason in Notes)

## Feasibility appendix

The **Driving surface** is what triggers the behavior (prefer the real entry point — a real `orch
resume`/`orch retry` run); the **Observation surface** is where the result is read (prefer the true
external boundary — rendered TUI, exit code, stderr, on-disk `state.json`/`logs/`, runner boundary).

Project bias to carry into implementation: drive a real run with a `FakeRunner` and assert the
external outcome (a `full-host` scenario or a real-CLI integration test) rather than unit-poking a
component. The feature does not exist yet, so **most behaviors are not testable today**. Landing the
infra below must keep `bun run check` (lint + typecheck + unit + mocked-integration) green.

**Two split-by-effort realities surfaced by feasibility review:**
1. The **completed read-only open** is cheap — the `'failed'`/`'completed'` `StepsViewState`
   already projects from `state.json` without executing anything (`project-steps-view.ts`
   `finalizeView`). The work is routing the open **away** from `executor.resume()` (which flips
   status to `'running'` first — `workflow.ts:2110`), away from `writeResumePreamble` (which logs),
   and neutralizing the teardown `notifyRunEnd` cmux hook (`resume.ts`). None is gated today.
2. The **failed interactive retry/continue** is substantially harder and needs **net-new infra** a
   planning pass must build before AT-2/AT-3/AT-R* are runnable:
   - a **host→CLI action channel** — `steps-view.tsx` `useInput` binds only nav/`⏎`/`q` today
     (no `[r]`/`[c]`), and `awaitForegroundShutdown()` returns only `quit`/`attach-exited`; a third
     "user action" outcome must thread from the Ink view up through the host to the CLI;
   - a **single-step execution mode** in `workflow.ts` — the executor runs the whole body; there is
     no "run exactly one step then re-park" primitive that `[r]` (retry-then-park) needs (`[c]` ≈
     today's resume re-run);
   - a **shared single-attempt fork/resume primitive** — `forkResumeCommand` (Claude
     `--resume --fork-session`; Codex rollout-copy) is reachable only from the autonomous loop with
     a fixed nudge today; manual retry with the configured/overridable instruction must lift it out
     (Codex session-id capture can fail — cross-runner parity is a real unknown, brainstorm open Q).

| ID    | Testable today | Driving surface | Observation surface | Gap & suggested change |
| ----- | -------------- | --------------- | ------------------- | ---------------------- |
| AT-1  | no  | Real `orch resume <completed-id>` vs a finished-run fixture (`full-host:fake-agent`) | Left steps pane (completed summary) | Open must branch on `status==='completed'` into the viewer instead of throwing. Add a finished-run **fixture builder** + a scenario `LaunchSpec` that opens a pre-finished fixture without executing. |
| AT-2  | no  | Real `orch resume <failed-id>` vs a `failed` fixture | Left steps pane footer (interactive `failed` variant) | The failed open must **park** at the `failed` view (no `setStatus('running')`, no execution) and expose `[r]`/`[c]`. Needs the host→CLI action channel (effort-item 2). |
| AT-3  | no  | Real `orch resume` (failed + completed) | Footers of both views | Assert failed footer **adds** `[r]`/`[c]`; completed does not. Needs AT-2. |
| AT-4  | no  | Real `orch resume <completed-id>` then quit | Exit code | Needs the read-only open path so a clean `q` yields `0`. |
| AT-5  | no  | Real `orch resume <completed-id>` vs `FakeRunner` | Runner boundary (zero invocations) | Read-only path skips execution entirely; assert via a spy runner recording zero step invocations. |
| AT-6  | partial | Real `orch resume <completed-id>` | stderr + exit code | Today `completed` throws `ResumeError`→`CANNOT_RESUME` (provable now). **Note:** `failed` does **not** throw today — it re-runs; so the "no cannot-resume" claim is already true for failed but for the wrong reason. After the change: no error for either, via the deliberate open paths. |
| AT-7  | yes | Real `orch resume <crashed-id>` | Persisted state advancing past crash | Existing resume path; add a regression assertion that crashed is untouched by the new branch. |
| AT-8  | yes | Real `orch resume <running-id>` | Persisted state progressing | Existing path; add explicit regression assertion. |
| AT-9  | partial | Real bare `orch resume`, mixed fixtures | Resumed run progressing + no prompt | Auto-discovery exists; the "never offer finished when a resumable exists" guard is new. |
| AT-10 | no  | Real bare `orch resume`, finished-only fixtures, TTY (`lifecycle`) | Confirmation text on stderr | New status-aware fallback + a confirm/prompt service. Add `FakePromptService.confirm()`; wire into resume deps; TTY-gated `lifecycle` driver. |
| AT-11 | no  | Real bare `orch resume` + confirm | Rendered TUI + exit code | AT-10 + the confirm branch opening the right view per status (AT-1/AT-2). |
| AT-12 | no  | Real bare `orch resume` + decline | stderr (no TUI) | AT-10 + the decline branch printing "nothing to resume". |
| AT-13 | yes | Real bare `orch resume`, empty runs dir | stderr + exit code | Existing guard; add regression assertion. |
| AT-14 | partial | Real `orch resume <finished-id>` open→quit, **no action** | Before/after `state.json` | Observation surface exists (`FileStateStore`). Driving surface blocked on AT-1/AT-2; the open must succeed first (the Given guards a vacuous pass). Failed half also depends on AT-R4 (no action taken). |
| AT-15 | partial | Real `orch resume <finished-id>` open→quit, no action | Lifecycle-event consumer (deliberate internal seam) | Skip the executor on an un-actioned open (no `run:ended`). Consider a test consumer of the lifecycle stream. |
| AT-16 | partial | Real `orch resume <finished-id>` open→quit, no action, cmux env | cmux notifications + pills | Un-actioned open must use a no-op cmux host **and** neutralize the teardown `notifyRunEnd` hook (`resume.ts`) — currently fires unconditionally on teardown. Relates to "cmux run-end bound to teardown". |
| AT-17 | partial | Real `orch resume <finished-id>` open→quit, no action | Before/after `logs/` | Un-actioned open must skip `writeResumePreamble` and the per-run logger; assert via filesystem diff or a `SessionLogger` spy recording zero appends. |
| AT-18 | no  | Real `orch resume <finished-id>` + `⏎` on a past interactive step | Right pane (replay) | Replay exists for live runs; needs the open container (AT-1/AT-2) so inspect is reachable. |
| AT-19 | partial | Real `orch resume <finished-id>` + `⏎` (both views) | Before/after `state.json` | Depends on AT-18; assert no mutation across the inspect, including in the failed interactive view. |
| AT-20 | no  | Real `orch resume <finished-id>` no TTY (`lifecycle`) | stderr + exit code | Headless branch (resolved): refuse, name run+status, non-zero, never hang **or** silently re-run a failed run. Needs TTY detection at the resume entry. |
| AT-21 | no  | Real bare `orch resume` no TTY, finished-only | stderr + exit code | Headless branch (resolved): no auto-fallback/auto-retry without a TTY; behave as "nothing to resume". |
| AT-22 | yes | Real `orch resume <ambiguous-prefix>` | stderr + exit code | Existing handling; regression assertion that prefix semantics are unchanged. |
| AT-R1 | no  | Real `orch resume <failed-id>` + `[r]`, `FakeRunner` scripted fail-then-pass | Runner boundary (one re-invocation) + rendered view | Needs the action channel (effort-item 2) + single-step retry primitive. Fake runner must support fail-then-pass scripting. |
| AT-R2 | no  | Real `orch resume <failed-id>` + `[r]`, `FakeRunner` scripted fail-again | Rendered view (back to failure) | Same infra; fake runner scripted to fail again. |
| AT-R3 | no  | Real `orch resume <failed-id>` + `[c]` | `state.json` `failed→completed` | `[c]` ≈ existing resume re-run, triggered on user action. Needs the action channel. |
| AT-R4 | partial | Real `orch resume <failed-id>` open→quit, no action | Before/after `state.json`/`logs/` + exit 0 | The failed-side replacement for AT-14..17. Blocked on AT-2 (open must succeed without executing). |
| AT-R5 | no  | Real `orch resume <failed-id>` + `[r]`/`[c]`, fake runner recording the prompt | Runner boundary (instruction handed in) | Needs the shared instruction source (sibling D3/D7) reachable from this path + the shared fork primitive (effort-item 2). |
| AT-R6 | no  | Real `orch retry <failed-id>` | Runner boundary + `state.json` advancing | New `retry` command (register in `main.ts` `COMMANDS`) wrapping the auto-`[c]` path; cannot precede the core action work. |
| AT-R7 | partial | Real `orch retry <completed|crashed|running-id>` | stderr + exit code | The rejection path is cheap and testable early (status check + message + non-zero), even before the retry core lands. Likely reuses a narrowed `ResumeError`/`CANNOT_RESUME` (open Q #1). |
| AT-R8 | no  | Real `orch retry <failed-id>` no TTY | stderr + exit code | Headless `retry` runs the configured default, never blocks. Needs the retry core + configured-instruction source + TTY detection. |
| AT-R9 | yes (for the resolution half) | Real `orch retry <prefix>` | stderr + exit code | Prefix resolution can be shared with `resume` immediately; the act-on-match half needs the retry core. |
| AT-R10| no  | Two sequential real invocations (`retry` then `resume`/`retry`) | Second invocation renders correct view, no corruption | Needs the retry core + coherent state/cache writes (MEMORY: manual retry must not corrupt cache replay). |
| AT-R11| partial | Real `orch resume <failed-id>` + `[c]` to completion, cmux env | cmux pill `failed→completed` | Inverse guard for AT-16; needs `[c]` core + cmux host observation. Relates to "cmux run-end bound to teardown/settle". |
