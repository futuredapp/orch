# Re-open a finished run from the CLI — read-only for completed, interactive retry for failed

**Status:** Requirements — human-reviewed acceptance contract
**Date:** 2026-06-09 (v2 redesign — supersedes the original "open completed/failed read-only" framing)
**Scope tier:** Standard→Deep (the `completed` read-only open is small; the `failed` interactive
retry/continue path and the new `orch retry` verb are a deeper, cross-runner change)

## Problem

When a run has finished, the CLI gives you a dead end instead of the run:

- **Completed run.** `orch resume <runId>` against a `completed` run fails with a hard error —
  `Cannot resume run "<id>": run already completed` (`ResumeError`, raised at
  `src/core/workflow.ts:2109`, mapped to `EXIT.CANNOT_RESUME` in `src/cli/commands/resume.ts`).
  The user reached for `resume` to *look at* a finished run and hit a wall. The frustrating part:
  the orchestrator *already knows how to display a finished run read-only* — the two-pane TUI has
  a `'completed'` `StepsViewState` variant (`src/hosts/two-pane/steps-view/step-types.ts`) that
  renders the end-of-run summary (`end-of-run-summary.tsx`) — header `orch · <workflow> · <runId>
  · completed`, footer `run completed · q to quit · ⏎ to inspect`, with replay of past
  interactive steps wired up. For `completed`, the block is *purely* the resume guard, which
  throws before that TUI is ever reached.

- **Failed run.** `orch resume <failed-id>` does **not** error today — it silently **re-runs the
  failed step for real** (the guard only throws on `completed`; `failed`/`crashed`/`running` all
  fall through to `setStatus('running')` + re-execute). So a user who types `orch resume
  <failed-id>` to *look at* what failed gets a full re-run with no warning and no chance to decide.
  What the user actually wants is to **see the failure first, then choose** whether to retry the
  failed step or retry-and-continue — not to have the decision made for them at the prompt.

So this feature is two related moves: **let `resume` reach the viewer that already exists for
`completed`**, and **turn `resume` on a `failed` run into a deliberate, interactive choice**
(see the failure → decide to retry/continue), plus a shorthand verb (`orch retry`) for "re-run and
finish it" without the interactive step.

> **Sibling feature.** [`in-tui-failure-resume-brainstorm.md`](in-tui-failure-resume-brainstorm.md)
> covers the **live failure moment** — keeping the TUI open *instead of* tearing down when a step
> fails, and retry/continue *before you ever quit*. This doc covers the **CLI re-entry moment** —
> you quit (or never had the run open), and you come back via `orch resume <id>` / `orch retry
> <id>`. The two share the same `'failed'` view, the same `[r]`/`[c]` retry/continue action
> semantics, and the **same configured retry/continue instruction source** (see D7). They are
> separate features with one shared core.

## Goals

1. `orch resume <completed-id>` opens the existing read-only end-of-run TUI instead of erroring.
   Nothing re-runs. Clean success: exit `0`.
2. `orch resume <failed-id>` opens the run in the **interactive failure view**, where the user
   chooses to **retry the failed step**, **retry-and-continue** to the end, or **quit** — rather
   than silently re-running. Merely opening and looking mutates nothing.
3. A new **`orch retry <id>`** verb = `orch resume <id>` + immediately trigger **retry-and-continue**
   (re-run the failed step, then proceed to completion). It is the non-interactive "fix it and
   finish" shorthand. It acts only on `failed` runs.
4. Bare `orch resume` (no id) keeps auto-discovering genuinely-resumable runs, and when none
   exist, **offers** the newest finished run and opens it **only after explicit confirmation** —
   with the confirmation telling the user whether it opens read-only (completed) or the
   interactive failure view (failed).
5. Observation stays pure: opening a finished run and *not* acting on it leaves persisted state and
   lifecycle exactly as they were. Acting on a failed run (retry/continue) mutates intentionally
   and coherently.
6. Retry/continue behavior is defined for both the **Claude Code** and **Codex** runners and for
   **non-interactive** sessions — first-class, not afterthoughts — and reuses the sibling feature's
   configured instruction source (one source of truth).

## Non-goals

- **`completed` is observation only.** No retry/continue/edit affordances on a completed run — a
  completed run has nothing left to run. Inspect past interactive steps (`⏎`) and quit (`q`).
- **No live-failure / stay-in-TUI behavior here.** Keeping the TUI open at the *moment* a step
  fails (instead of tearing down) is the sibling feature. This doc is about coming *back* to a
  run from the CLI, plus the `orch retry` verb.
- **No new rendering of the failure view.** We inherit the existing `'failed'` `StepsViewState`
  and end-of-run summary; making it *interactive* (adding `[r]`/`[c]` actions + the host→CLI
  action channel) is in scope, but the visual treatment is not redesigned here.
- **No re-design of the configured retry/continue instruction schema.** Where that config lives
  and its shape is the sibling feature's call (sibling D3/D7); this feature *consumes* it.
- **`crashed`/`running` are unchanged.** They still resume for real (continue executing). `orch
  retry` does **not** touch them (D4).

## Decisions (the acceptance contract)

### D1 — Completed opens read-only
`orch resume <completed-id>` opens the existing read-only end-of-run TUI. No steps execute. Exit
`0` on a clean quit. Pure observation (D6).

### D2 — Which states, and what each opens
| Run status   | `orch resume <id>` behavior                                                      |
|--------------|----------------------------------------------------------------------------------|
| `completed`  | **Open read-only** (new) — observation only                                      |
| `failed`     | **Open the interactive failure view** (new) — see the failure, then choose (D3)  |
| `crashed`    | Resume for real (unchanged) — continues execution                                |
| `running`    | Resume for real (unchanged)                                                       |

Rule of thumb: **a completed run you can only look at; a failed run you look at, then decide.**
(`failed` is deliberately *not* folded in with `completed` — a failed run is continuable, which is
exactly why `resume` re-runs it today, and why the sibling feature exists.)

### D3 — The interactive failure view
`orch resume <failed-id>` parks at the existing `'failed'` view, now interactive. From there:

- **`[r]` retry the step** — re-execute the failed step in place, retry instruction injected
  (D7). Passes → step marked ok, run stays parked ready to continue; fails again → back to the
  failure view (retry again, continue, or quit). Stops after the single step.
- **`[c]` retry-and-continue** — re-run the failed step, then proceed forward through the rest of
  the workflow to the end, continue instruction injected (D7).
- **`[q]` quit** — leave the run in its `failed` terminal state and exit. (Quitting *without*
  having acted is pure observation — D6.)
- **`⏎` inspect** — replay a past interactive step in the right pane. **Pure** — inspect never
  mutates, even in the failed interactive view; only `[r]`/`[c]` mutate.

### D4 — New verb: `orch retry <id>`
`orch retry <id>` ≈ `orch resume <id>` + immediately trigger **retry-and-continue** (re-run the
failed step, proceed to completion — the `[c]` action without the interactive keypress).

- Acts **only** on `failed` runs.
- On `completed`/`crashed`/`running`: **reject** with a clear, status-named message ("retry
  applies only to failed runs; use `orch resume`") and a non-zero exit. It does not silently fall
  back to resume or read-only.
- Reuses the existing ambiguous-prefix / not-found resolution from `resume` (no new
  prefix semantics).

### D5 — Auto-discovery with status-aware confirmed fallback
- Bare `orch resume` first auto-discovers the most recent **resumable** (`crashed`/`running`) run
  and resumes it, exactly as today. The fallback never fires when a resumable run exists.
- If no resumable run exists, it identifies the most recent `completed`/`failed` run and **asks
  the user to confirm** before opening it. The confirmation **states which kind of open** it is,
  because opening a failed run lands in a mutating-capable interactive view:

  ```
  No resumable run found. Most recent run abc123 (my-workflow) failed 2h ago.
  Open it in the interactive failure view (retry/continue available)? [y/N]
  ```
  ```
  No resumable run found. Most recent run abc123 (my-workflow) completed 2h ago.
  Open it read-only? [y/N]
  ```

  - Confirm (`y`) → open (read-only for completed, interactive failure view for failed), exit `0`
    on a clean quit.
  - Decline (`N`/default) → exit without opening; "nothing to resume".
  - No runs at all → today's "no resumable run found" behavior.

  (Final copy is planning's call; the *status-distinguishing* requirement is fixed.)

### D6 — Observation is pure until you act
Opening a finished run for viewing, and quitting **without** taking a retry/continue action, must
**not**:
- mutate `.orch/state/<runId>/state.json` or change `status`/`endedAt`,
- re-emit `run:ended` or other run-lifecycle events,
- trigger cmux side effects (notifications, status-pill changes — `src/hosts/cmux/cmux-host.ts`),
- write new run logs as if execution happened.

This holds for: **(a)** any `completed` run, and **(b)** a `failed` run that is **opened but not
actioned** (looked at, maybe inspected, then quit).

Once the user **does** retry/continue a failed run, mutation is **intentional and required** — but
it must be **coherent**: the failed step's attempt state updates, the cache-replay that a later
`orch resume`/`orch retry` depends on is not corrupted, and a successful retry-and-continue may
legitimately update the run's status and the cmux pill (`failed → completed`). "Pure" is a
property of *opening*, not of *acting*.

> Implementation note (not prescriptive): a side-effect-free open requires routing the
> `completed`/`failed` open down a path that does **not** call the existing `executor.resume()`
> (which flips status to `'running'` first), does **not** write the resume preamble/log, and
> neutralizes the teardown `notifyRunEnd` cmux hook. None of those three is gated today — see the
> feasibility appendix in [acceptance-tests.md](acceptance-tests.md).

### D7 — One instruction source, shared with the sibling
The retry instruction (`[r]`/`orch retry`) and continue message (`[c]`) come from the **same
configured source of truth** the sibling feature defines (sibling D3/D7): one set of
author-configurable instructions used by interactive in-TUI retry, this CLI re-entry retry, and
the autonomous recovery path. On retry/continue the agent is made **aware a prior attempt failed**
(reusing the fork/`checkpointSessionId` session-resume plumbing where the runner supports it). A
sensible built-in default exists when nothing is configured. In the **interactive** `resume
<failed>` view the configured instruction may be **accepted or overridden** with a typed nudge (same
TUI as the sibling). `orch retry` (the script-like shorthand) uses the **configured default**
without prompting.

### D8 — Headless (no TTY) behavior diverges by verb
- `orch resume <finished-id>` (completed or failed) with **no interactive terminal** → **refuse**:
  print a clear message naming the run and its status, non-zero exit. It neither opens a TUI nor
  hangs nor silently mutates. (A `failed` run is *not* re-run by `resume` without a TTY — no
  surprise mutation.)
- `orch retry <failed-id>` with **no interactive terminal** → **runs** the retry-and-continue using
  the **configured-default** instruction, never blocks on input; exit code reflects the retry
  outcome (success vs failed-again). Acting is the whole point of the verb.
- `orch retry` on a non-`failed` run → rejected regardless of TTY (D4).
- Bare `orch resume` with no TTY and only finished runs → today's "nothing to resume", non-zero
  exit, never auto-opens.

## Edge cases

- **Explicit completed ID** → read-only (D1). Headline observation path.
- **Explicit failed ID** → interactive failure view (D3); user chooses retry/continue/quit.
- **Explicit crashed/running ID** → unchanged real resume.
- **`orch retry <failed-id>`** → opens + auto retry-and-continue (D4).
- **`orch retry <completed|crashed|running-id>`** → rejected, status-named message, non-zero (D4).
- **Retry fails again** (in the interactive view) → back to the failure view; retry (fresh
  override), continue, or quit. No manual-retry ceiling imposed by this feature.
- **Quit a failed view without acting** → run stays `failed`; pure (D6); clean quit exits `0`
  (you observed, you didn't act).
- **A later `orch resume`/`orch retry` after a CLI retry** → loads cleanly; cache replay and
  attempt state are coherent; opens in the view matching the run's now-current status.
- **Bare `resume`, a resumable run exists** → resumes it; fallback never fires.
- **Bare `resume`, only finished runs exist** → status-aware confirmation for the newest (D5).
- **Bare `resume`, no runs at all** → existing "nothing to resume".
- **Ambiguous run-ID prefix** (for both `resume` and `retry`) → existing prefix handling; this
  feature doesn't change prefix-resolution semantics.

## Open questions

1. **`ResumeError` / `EXIT.CANNOT_RESUME` fate.** With `completed` opening read-only and `failed`
   opening interactively, the `status === 'completed'` guard no longer throws for normal finished
   runs. `orch retry` *does* need a rejection path for non-`failed` statuses (D4) — likely the
   same error type, repurposed/narrowed (e.g. "this verb can't act on this status", or a
   genuinely-corrupt/un-viewable state). Removal vs narrowing is planning's call; no
   currently-reachable user path should still hit "cannot resume" for a normal finished run.
2. **Parallel-step failure granularity.** If the failed step is a parallel block (`ParallelError`),
   does `[r]`/`[c]` re-run the whole block or the failed branch? (Shared with sibling open Q.)
3. **Reachability of the pure open + the host→CLI action channel.** D6's zero-mutation contract
   and D3's interactivity both depend on infra that does not exist today (a no-execution open path;
   an action channel from the Ink view up to the CLI so `[r]`/`[c]` can drive execution). The
   *contract* above is fixed; whether it's cleanly reachable is a planning spike (feasibility
   appendix in [acceptance-tests.md](acceptance-tests.md)).

## Success criteria

- `orch resume <completed-id>` opens the read-only view and exits `0` on quit; never prints
  "cannot resume" for a normal completed run.
- `orch resume <failed-id>` opens the **interactive failure view** (never a silent re-run); the
  user can retry, retry-and-continue, or quit.
- `orch retry <failed-id>` re-runs the failed step and continues to completion in one command;
  `orch retry` on a non-failed run is rejected with a non-zero exit.
- Resuming a `crashed`/`running` run behaves exactly as before (regression-guarded).
- Bare `orch resume` with no resumable run prompts (status-aware) before opening the newest
  finished run, and does nothing on decline.
- Opening + quitting a finished run **without acting** leaves `.orch/state/<runId>/state.json`
  byte-for-byte unchanged with no `run:ended`/cmux/log side effects — for completed runs and for
  unactioned failed runs. After a retry, state mutates coherently and a later `resume`/`retry`
  still works.
- Retry/continue is defined and tested for Claude Code and Codex and for non-interactive sessions,
  reusing the sibling's configured instruction source.

## Reference: relevant code (for planning, not prescriptive)

- Resume command & exit-code mapping: `src/cli/commands/resume.ts` (`resumeCmd`,
  `findResumableRun` — currently `crashed`/`running` only, `mapResumeError`, `writeResumePreamble`)
- The guard that currently errors (completed only): `src/core/workflow.ts:2109` (`ResumeError`);
  the unconditional `setStatus('running')` at `:2110` that breaks a pure open
- Error type: `src/core/errors.ts` (`ResumeError`)
- Run state model (`'running' | 'completed' | 'failed' | 'crashed'`): `src/state/state-store.ts`
- Read-only / failure TUI view: `src/hosts/two-pane/steps-view/step-types.ts` (`StepsViewState`
  `completed`/`failed`/`crashed`), `end-of-run-summary.tsx`, `project-steps-view.ts`
  (`finalizeView`), `steps-view.tsx` (`useInput` — today binds only nav/`⏎`/`q`; `[r]`/`[c]` and
  the host→CLI action channel are unbuilt)
- Resume/execute attach plumbing: `src/cli/commands/execute-with-attach.ts`
  (`awaitForegroundShutdown` returns only `quit`/`attach-exited` — needs a third "user action")
- Reusable recovery + fork/session-resume: `src/core/recovery/loop.ts`, the `forkResumeCommand`
  runner method (Claude `--resume --fork-session`; Codex rollout-copy) — currently reachable only
  from the autonomous loop with a fixed nudge; manual retry needs it lifted into a shared primitive
- cmux lifecycle side effects to suppress on a pure open: `src/hosts/cmux/cmux-host.ts`
  (`notifyRunEnd`/`fireRunEnd`, `createNoOpCmuxHost`)
- CLI command registration (for the new `orch retry`): `src/cli/main.ts` (`COMMANDS`)
- Autonomous recovery design this composes with:
  `docs/brainstorms/2026-06-02-feat-agent-error-recovery-requirements-interactive-version.md`

## Acceptance Tests

Plain-language behavioral acceptance criteria live in the sidecar
[acceptance-tests.md](acceptance-tests.md) (Given/When/Then, one behavior per test). They are the
contract the implementation is checked against. Most are not testable today (the feature is
unbuilt); the sidecar's feasibility appendix records the test-infra gaps a planning/implementation
pass must close.
