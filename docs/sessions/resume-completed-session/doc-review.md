# Doc review — Re-open a finished run from the CLI (`resume` + `retry`)

**Reviewed:** `docs/sessions/resume-completed-session/brainstorm.md` + `docs/sessions/resume-completed-session/acceptance-tests.md` (read together, with `docs/sessions/resume-completed-session/in-tui-failure-resume-brainstorm.md` as the sibling-feature context).
**Date:** 2026-06-09
**Method:** Code-claim verification against `src/` + independent persona reviewers (coherence, adversarial) for the original docs, then a second round of reviewers (feasibility, coherence, spec-flow) for the redesign the user chose.

## What happened in this review

The review found one scope-affecting defect in the original contract, surfaced it, and the user
responded with a **redesign**. Both docs were then rewritten to the new contract. This file records
the whole arc.

## Round 1 — the defect that was found (original "open completed/failed read-only" contract)

**Verified ground truth (from the code):**
- `src/core/workflow.ts:2109` — the resume guard is **only** `if (state.status === 'completed') throw new ResumeError(...)`. `completed` is the *only* status that errors.
- `failed`, `crashed`, `running` all currently **resume for real** (`setStatus('running')` then re-execute, re-running from the failed/last step). **A `failed` run does not error on `orch resume <id>` today; it continues execution.**
- `src/cli/commands/resume.ts` `findResumableRun` auto-discovers only `crashed`/`running`.
- Header/footer copy quoted in the brainstorm is accurate (`end-of-run-summary.tsx`).

**The defect (BLOCKER, confirmed independently by both reviewers):** the original doc folded `failed` in with `completed` as "finished → open read-only," justified by "if it can't be continued, you can still look at it." But a `failed` run **is** continuable — `orch resume <failed-id>` re-runs the failed step today, and the sibling doc's whole premise is retrying/continuing failed runs. The original design would have **silently removed CLI continuation of a failed run** and **contradicted the sibling doc's** Non-goal ("not a change to the observable semantics of CLI `orch resume`") and Problem statement ("`orch resume` … re-runs from the last failed step"). It was presented as purely additive "(new)" with no acknowledgement that a capability was being deleted.

This was **flagged, not auto-fixed** (scope-affecting), and put to the user.

## The user's decision — redesign (v2)

The user rejected both "keep failed read-only" and "leave it unchanged," and chose a third path:

> `orch resume <failed-id>` should **show the failed run and let the user decide** to retry the step (either retry-the-step, or retry-and-continue). Plus a **new `orch retry <id>`** command = `orch resume` + retry action.

Three follow-up decisions (asked because they define the new verb's contract; all resolved with the recommended default):

| Decision | Chosen |
| --- | --- |
| `orch retry <id>` semantics | **Retry-and-continue** to completion (not retry-only-and-park). |
| Headless (no TTY) behavior | **Diverge by verb:** `orch resume <finished>` refuses; `orch retry <failed>` runs the configured default, never blocks. |
| `orch retry` on non-failed runs | **Reject all** (completed/crashed/running) with a status-named message + non-zero exit. |

## Round 2 — reviewing the redesign (three reviewers)

- **Feasibility (code-seam):** the **completed read-only open is cheap** (the `failed`/`completed` `StepsViewState` already projects from `state.json` without executing — `project-steps-view.ts`). The **failed interactive retry/continue is substantially harder** and needs net-new infra: a host→CLI **action channel** (no `[r]`/`[c]` keymap today; `awaitForegroundShutdown` returns only `quit`/`attach-exited`), a **single-step execution mode** in `workflow.ts` (no "run one step then re-park" primitive), and **lifting the fork/`forkResumeCommand` primitive out of the autonomous loop** (currently only reachable with a fixed nudge; Codex session-id capture can fail → cross-runner parity is a real unknown). A side-effect-free open must route away from `executor.resume()` / `writeResumePreamble` / the teardown `notifyRunEnd` hook — none gated today.
- **Coherence:** the new boundary is **clean** (sibling = live failure moment / before you quit; this doc = CLI re-entry / after you quit, plus `orch retry`). Two required reconciliations: the sibling's stale Non-goal, and an explicit statement that CLI retry/continue **reuse the sibling's single instruction source** (not a second, divergent implementation).
- **Spec-flow:** the "read-only means read-only" guarantees can no longer claim byte-for-byte invariance over a *retried* failed run — they must be re-scoped to **completed runs** and **failed-runs-opened-but-not-actioned**. Produced an AT delta table + new ATs.

## What was changed (applied to the docs)

### `brainstorm.md` — rewritten to v2
- Retitled to "Re-open a finished run from the CLI — read-only for completed, interactive retry for failed."
- **Problem** now states the truth for both statuses: `completed` errors (guard); `failed` *silently re-runs today* (the thing the user wants to turn into a deliberate choice).
- **D2** table: `completed` → read-only; `failed` → **interactive failure view**; `crashed`/`running` → unchanged. Rule of thumb corrected to "a completed run you can only look at; a failed run you look at, then decide."
- **D3** new — the interactive failure view actions: `[r]` retry-the-step, `[c]` retry-and-continue, `[q]` quit, `⏎` inspect (pure).
- **D4** new — the `orch retry <id>` verb (= resume + auto retry-and-continue; rejects non-failed).
- **D5** — auto-discovery fallback is now **status-aware** (confirmation states read-only vs interactive failure view).
- **D6** new — "observation is pure until you act": the zero-mutation guarantee is scoped to completed runs and un-actioned failed opens; acting mutates intentionally and coherently.
- **D7** new — one configured instruction source shared with the sibling (reuse, not re-implement).
- **D8** new — headless behavior diverges by verb (the resolved decision).
- Open questions, edge cases, success criteria, and the code-reference list all updated; feasibility realities folded in as risks (not gating).

### `acceptance-tests.md` — rewritten to v2
- Header documents the v2 changes and the resolved decisions.
- **Revised:** AT-2 (failed → interactive view, not read-only), AT-3 (footers intentionally differ), AT-10/AT-11 (status-aware fallback), AT-14–AT-17 (**re-scoped** to completed + un-actioned-failed opens), AT-19 (pure inspect in both views), AT-20 (refuse, and don't silently re-run a failed run).
- **Kept:** AT-1, AT-4–AT-9, AT-12, AT-13, AT-18, AT-21, AT-22.
- **New:** AT-R1..AT-R11 — failed-view retry/continue outcomes, the agent-awareness/instruction test, the `orch retry` verb (failed / non-failed / headless / prefix / state-coherence), and AT-R11 (the *positive* cmux side effect a successful retry-and-continue must fire — the inverse guard for AT-16).
- Feasibility appendix rewritten with the two split-by-effort realities and a per-AT gap table.

### `in-tui-failure-resume-brainstorm.md` — two minimal reconciling edits
- Non-goal "Not a change to the observable semantics of CLI `orch resume`" was **stale** under v2 (this feature *is* such a change). Replaced with a boundary statement: the CLI `resume`/`retry` surface is the sibling brainstorm's concern; this doc is the live failure moment. *(Clarifies the boundary the user themselves drew; not a scope change to that feature.)*
- D5 ("one instruction source") now lists the CLI re-entry / `orch retry` path alongside the in-TUI and autonomous paths.

## Residual open questions left in the docs (for planning, not blocking)

1. **`ResumeError` / `EXIT.CANNOT_RESUME` fate** — narrow/repurpose for `orch retry`'s non-failed rejection vs remove. (brainstorm open Q #1)
2. **Parallel-step failure granularity** — does `[r]`/`[c]` re-run the whole parallel block or the failed branch. (shared with sibling)
3. **Reachability** — the zero-mutation open path and the host→CLI action channel are net-new infra; the *contract* is fixed, but a planning spike must confirm clean reachability. (feasibility appendix)

## Not auto-fixed in Round 1 (and why)

Nothing was auto-fixed in Round 1. Every wording/factual nit found (the Problem framing, the D2 rule of thumb, the AT-6 feasibility note, the "continue" Non-goal wording) was entangled with the `failed`-scope decision, so fixing them pre-emptively would have pre-judged a user-owned decision. They were all resolved by the v2 rewrite instead.
