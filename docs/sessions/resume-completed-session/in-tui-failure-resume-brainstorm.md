# Stay in the TUI on failure, and retry/continue from inside the app

**Status:** Requirements — human-reviewed acceptance contract
**Date:** 2026-06-09
**Scope tier:** Standard→Deep (bounded UX, but a cross-runner + cross-mode "retry/continue protocol")
**Sibling doc:** [`brainstorm.md`](brainstorm.md) covers re-opening *finished* runs read-only via the
CLI `resume` command. This doc covers the **live failure moment** inside a running TUI and
in-app retry. They share the resume executor plumbing but are separate features.

## Problem

Two gaps, observed by the user:

1. **Failure ejects you from the TUI.** When a workflow step fails, the run finishes and the
   two-pane TUI is cancelled — you're dropped back to the shell. On *success* the TUI holds open
   until you press `q`; on failure it does not. (The code has a `'failed'` `StepsViewState`
   variant in `src/hosts/two-pane/steps-view/step-types.ts` and a projector path that renders it,
   but the observed behavior is teardown — most likely the failed step's rejected promise
   propagates up to the CLI `run` command and tears the host down before the failure view is
   interactive. Planning must confirm the exact mechanism; the requirement is the behavior, not
   the diagnosis.)

2. **Recovery requires leaving the app.** Today the only way to retry is to quit and run
   `orch resume` from the shell, which re-runs from the last failed step. The user wants that
   same capability *from within the running TUI* — and the plumbing largely exists in-process
   already (`WorkflowDeps`, the cache-replay resume logic in `src/core/workflow.ts`, and a
   generic recovery loop in `src/core/recovery/loop.ts`), so an in-app retry could call the same
   logic without spawning a new process.

There is also a separately-designed (not-yet-built) **autonomous** error-recovery feature (a
pane watchdog that auto-retries agent overloads — see
`docs/brainstorms/2026-06-02-feat-agent-error-recovery-requirements-interactive-version.md`).
This feature is the **user-initiated** counterpart and is designed to *compose* with it, sharing
the same instruction configuration.

## Goals

1. When a step fails, the TUI **stays open in an interactive failure state** instead of tearing
   down — the same way a successful run holds open until the user quits.
2. From that failure state the user can choose to **retry** the failed step or **continue**
   (resume the rest of the workflow), both executed **in-process** (no new `orch` process).
3. Retry and continue each send the agent a **distinct instruction** so the agent knows it is a
   retry / is continuing after a failure.
4. Instruction content comes from a **configured default** (per-step/workflow) with an **optional
   typed override** at retry time in interactive mode; **non-interactive mode always uses the
   configured default** and never blocks on input.
5. Behavior is defined and verified across the **Claude Code** and **Codex** runners and in
   **non-interactive** sessions — these are first-class, not afterthoughts.

## Non-goals

- **Not** the autonomous watchdog recovery feature (separate design). This composes with it; it
  does not rebuild it.
- **Not** a change to the read-only re-open behavior in the sibling `brainstorm.md`.
- **Not** the CLI re-entry behavior in the sibling [`brainstorm.md`](brainstorm.md) — that doc
  (v2) owns `orch resume <id>` opening completed runs read-only / failed runs in the interactive
  failure view, and the new `orch retry <id>` verb. This doc is the **live failure moment** inside
  a still-running TUI. The two share the `'failed'` view, the `[r]`/`[c]` action semantics, and the
  configured retry/continue instruction source (D5) — but the CLI `resume`/`retry` surface is the
  sibling's concern, not this one.
- **Not** in scope for `crashed` runs (orchestrator process died) — a dead TUI can't retry
  itself; those stay a CLI-`resume` job. This feature targets step-level `failed` runs where the
  orchestrator is still alive.

## Decisions (the acceptance contract)

### D1 — Failure holds the TUI open
On a step-level failure, the host does **not** tear down. It renders the interactive failure
state (the existing `'failed'` view variant, made reachable interactively) and waits for user
action. This mirrors the success path, where the TUI stays until `q`.

### D2 — Three actions from the failure state
From the parked failure state the user can:

- **`[r]` retry** — re-execute the failed step in place, with the retry instruction injected.
  Outcome: passes → step marked ok, run stays parked ready to continue; fails again → back to the
  failure state (retry again or choose another action).
- **`[c]` continue** — resume the workflow forward from the failed step through to the end (full
  `resume` semantics: re-run the failed step, then proceed), with the continue message injected.
- **`[q]` quit** — leave the run in its `failed` terminal state and exit (today's outcome, now a
  choice rather than the only option).

> Open nuance (see Open Questions): whether **continue** must first re-run the failed step (full
> resume) or can proceed *past* an unfixed failed step. Recommended default: full resume (re-run
> then proceed). Retry differs from continue only in that retry stops after the single step;
> continue runs to completion.

### D3 — Distinct, configured instructions for retry vs continue
- **Retry instruction** and **continue message** are separate, author-configurable values
  (the "special argument" the user described), defined at the step and/or workflow level.
- In **interactive** mode the configured default is shown and can be **accepted or overridden**
  with a typed nudge at retry time (e.g. "you missed the auth header, add it").
- In **non-interactive** mode the **configured default is always used**; no prompt, no blocking.
- A sensible built-in default exists when the author configures nothing (e.g. "Previous attempt
  failed; re-read the error and try again.").

### D4 — The agent must know it is a retry
On retry/continue, the agent is made aware that a prior attempt failed and is being re-driven.
Recommended mechanism (to validate per runner): **resume the agent's existing session** and
inject the instruction, reusing the fork/resume / `checkpointSessionId` plumbing that the
autonomous recovery loop already uses, rather than starting a blank session. The *requirement* is
agent-awareness + instruction delivery; the session mechanism is validated in planning (D6).

### D5 — One instruction source across modes
The configured retry/continue instructions are the **single source of truth** shared by:
- interactive manual retry/continue (this feature),
- the CLI re-entry retry/continue and `orch retry` verb (sibling [`brainstorm.md`](brainstorm.md) D7), and
- the non-interactive / autonomous recovery path (the sibling watchdog feature).

This keeps agent-facing behavior consistent whether a human (in-TUI or via CLI) or the watchdog
triggers recovery.

### D6 — Cross-runner + cross-mode validation is part of "done"
The feature is not done until retry/continue behavior is defined and tested for:
- **Claude Code** runner (session resume/fork supported),
- **Codex** runner (validate its session/continuation semantics — may differ),
- **non-interactive** sessions (configured default, no blocking).

## Edge cases

- **Retry fails again** → returns to the failure state; user can retry (fresh override), continue,
  or quit. No attempt ceiling is imposed by this feature on *manual* retries (unlike the bounded
  autonomous loop) — confirm in Open Questions.
- **Continue past a still-failing step** → governed by the D2 nuance; default re-runs the step.
- **Non-interactive failure with no autonomous recovery configured** → behaves as today (run
  ends `failed`, non-zero exit). The retry/continue *config* still applies if/when the autonomous
  path runs. (Confirm in Open Questions.)
- **Crashed run (orchestrator died)** → out of scope here; CLI `orch resume` path.
- **A parallel step fails** (`ParallelError`) → define whether retry re-runs the whole parallel
  block or the failed branch. (Open Question.)
- **Override typed in interactive mode** → augments, does not replace, the "this is a retry"
  framing — the agent still knows it's a retry, plus the user's nudge.
- **State/caching** → a manual retry must update run state coherently (step attempt count,
  optional `recoveryLog` entry) without corrupting the cache replay used by CLI `resume`.

## Open questions

1. **Session model per runner (the user's primary concern).** Does retry resume the *same* agent
   session (agent retains its failed-attempt context) or start a fresh session with the
   instruction injected? Recommended: same-session resume where the runner supports it
   (Claude Code via `checkpointSessionId`/fork), with a defined fallback for runners that lack
   session resume. **Codex parity must be investigated** — its continuation semantics may differ
   from Claude Code's.
2. **Continue semantics.** Re-run the failed step then proceed (full resume — recommended), or
   allow proceeding past an unfixed failed step with a "previous step failed" message to the next
   agent? Pick one and make it the contract.
3. **Non-interactive failure with no recovery configured.** Fail as today (recommended), or
   perform a single configured-default retry automatically? Decide whether non-interactive ever
   auto-retries absent the autonomous watchdog.
4. **Manual retry budget.** Should manual retries be unbounded (user-driven), while only the
   autonomous loop is bounded? Recommended: unbounded for manual.
5. **Exact current teardown-on-failure mechanism.** Confirm the rejected-promise→host-teardown
   hypothesis so D1 changes the right seam.
6. **Parallel-step failure granularity** (re-run block vs branch).
7. **Where the configured instruction lives** (step config vs workflow config vs both) and its
   precedence with a typed override — a small schema decision for planning.

## Success criteria

- On a step-level failure, the TUI **remains interactive** in a failure state; the user can
  retry, continue, or quit. It no longer ejects to the shell automatically.
- **Retry** re-runs the failed step **in-process** (no new process); the agent receives the
  configured-or-overridden retry instruction and is aware it is a retry.
- **Continue** resumes the rest of the workflow in-process with the continue message.
- **Non-interactive** runs use the configured defaults, never block on input, and behave
  identically in spirit to interactive minus the override prompt.
- Behavior is verified on **both** the Claude Code and Codex runners.
- A manual retry leaves run state/cache coherent — a subsequent CLI `orch resume` still works.

## Reference: relevant code (for planning, not prescriptive)

- Failure marking + terminal status: `src/core/workflow.ts` (≈ `executeWorkflowFn`, the
  `isStepLevelFailure` branch and `setStatus(... 'failed' | 'crashed')`)
- Failure UI choreography (writes failure pane, emits error banner):
  `src/hosts/two-pane/lifecycle-choreographer.ts`
- Host teardown path (success vs failure trigger): `src/hosts/two-pane/tmux-host.ts`
  (`wrapHostWithStepsView` / `wrappedTeardown`)
- Failure/`'failed'` view + projector: `src/hosts/two-pane/steps-view/step-types.ts`,
  `src/hosts/two-pane/steps-view/project-steps-view.ts` (`finalizeView`)
- Resume mechanics (cache replay, re-run from failed step): `src/core/workflow.ts` (`resume`,
  the executor cache-hit/skip logic) and `src/cli/commands/resume.ts`
- Generic, process-agnostic recovery loop (reusable): `src/core/recovery/loop.ts`
- Autonomous recovery design this composes with:
  `docs/brainstorms/2026-06-02-feat-agent-error-recovery-requirements-interactive-version.md`
