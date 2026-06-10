# Phase 2 — U7 status-aware bare-resume fallback — implementation summary (round 5)

**Phase:** 2 of 3 (`plan.md` → "Interactive `failed` view + retry core + status-aware fallback")
**Status:** Phase 2 still **in-progress**, but **all implementation units (U4–U7) are now
landed**. This round shipped **U7** — the status-aware bare-resume fallback. What remains in
Phase 2 is the gated real-CLI / full-host *observable assertion* work on U6 (no new product code).
**Gate:** `bun run check` green end-to-end (lint → typecheck → `test:project` incl.
integration → `test:two-pane:lifecycle` → migration overlap/import-parity/`_migration`).
No schema migration; no public-API barrel change.

## What this round ships — U7: bare `orch resume` status-aware fallback

Bare `orch resume` (no run id) used to do exactly one thing when no `crashed`/`running` run
existed: print "No resumable run found" and exit non-zero — even when a `completed`/`failed` run
the user clearly wanted to re-open was sitting right there. U7 adds the D5 fallback: offer the
newest finished run, behind a confirmation, and open it in the matching view.

### `src/cli/commands/resume.ts` — the new path

- **Refactor (no behavior change):** split the old `resolveResumeTarget` into
  `loadResumeTarget(deps, targetId)` (the load + corruption + `workflowName` validation half) and
  `resolveExplicitTarget(deps, idArg)` (prefix-resolution + not-found half). Both the explicit
  path, the bare resumable path, and the new fallback now share one validated loader.
- **`resumeCmd` branch:** an explicit id resolves via prefix as before; bare `orch resume` first
  scans for a resumable (`crashed`/`running`) run and, **only when none exists**, hands off to the
  new `bareFinishedFallback`. A resumable run is therefore **never displaced** by a finished one
  (AT-9) — the fallback is unreachable while anything is genuinely resumable.
- **`findNewestFinishedRunId(deps)`:** scans recent runs newest-first (run ids are
  timestamp-prefixed and listed ascending, so newest = last), returning the first
  `completed`/`failed` run. Corrupt runs (`StateCorruptionError`) are skipped so the offer lands on
  the newest *openable* finished run rather than dead-ending on a corrupt newest.
- **`bareFinishedFallback(deps, cliArgs, opts, hostFactory)`:**
  - **No two-pane terminal** (`opts.mode !== 'two-pane'`) → it never even looks for a finished run:
    today's "No resumable run found" + `CANNOT_RESUME`, **no prompt** (D8 / AT-21). This mirrors
    the explicit finished-run refusal's TTY signal so the two paths agree on what "interactive"
    means.
  - **A finished run exists + two-pane** → confirm via the existing `deps.confirmService` (KTD-3 —
    no new prompt service) with **status-distinguishing copy**: it names the run id, workflow, and
    status, and states the open kind — `read-only` for `completed` vs `the interactive failure view
    (retry/continue available)` for `failed` (AT-10). The failed wording is load-bearing: opening a
    failed run lands in a mutating-capable view, so the user must know that before pressing `y`.
  - **Confirm (`y`)** → `openFinished` (completed) or `openFailed` (failed), the same view-opening
    primitives U1/U6 built (AT-11).
  - **Decline (`N`/default)** → `Nothing to resume.` on stderr, exit `0` (matching `orch init`'s
    decline house style — a deliberate user choice is not an error).

### Tests — `tests/integration/cli/commands/bare-resume-fallback.test.ts` *(new)*

Drives the **real** `resumeCmd` bare path over a real `FileStateStore` + a scripted
`FakeConfirmService`, asserting the external boundary (exit code, stderr, the recorded confirm
question text, and whether the host factory / confirm service was reached at all):

- **AT-9** — resumable (`crashed`) + finished (`completed`) seeded → bare two-pane resume takes the
  real resume path (`CONFIG_ERROR` at `loadWorkflow`, host never reached); `ConfirmService`
  recorded **zero** calls and stderr shows no prompt.
- **AT-10 (completed)** — only a completed run → the confirm question contains the run id, the
  workflow name, `completed`, and `read-only`, and **not** `interactive failure view`.
- **AT-10 (failed)** — a `failed` run (stamped via `setStatus`, since the fixture builder models
  completed/crashed/running) → the confirm question contains the id, `failed`, and `the interactive
  failure view (retry/continue available)`.
- **AT-11** — confirm (`y`) on a completed run → `openFinished` reached (stderr "read-only view"),
  exit `0`.
- **AT-12** — decline (`N`) → "Nothing to resume.", exit `0`, host factory never reached (a
  throwing factory proves it).
- **D8 / AT-21 guard** — bare resume with `mode: 'plain'` and a finished run present → "No
  resumable run found" + `CANNOT_RESUME`, confirm service never touched (an unscripted fake throws
  if reached).

## Design notes / decisions made

- **Reused `ConfirmService` (KTD-3), did not invent a prompt service.** It is already on
  `CliDeps.confirmService` (`ReadlineConfirmService` real, `FakeConfirmService` test) and already
  used by `orch init`. The feasibility appendix's assumed `FakePromptService.confirm()` was never
  needed.
- **`opts.mode === 'two-pane'` is the interactivity gate**, the same signal the explicit
  finished-run refusal (U3/U6) uses. A piped/CI invocation resolves to `plain`, so the fallback is
  inert headlessly — no prompt, no auto-open (D8). This keeps the explicit and bare paths agreeing
  on "is this an interactive terminal" rather than introducing a second TTY heuristic.
- **Decline → exit `0`.** Matches `orch init`'s `EXIT.OK` "No changes made." precedent. Declining a
  prompt is a successful, expected outcome — distinct from the "no run exists at all" error
  (`CANNOT_RESUME`). AT-12 only pins the stderr + no-TUI behavior; the code choice follows house
  style.
- **Corrupt-run skip in the scan.** `findNewestFinishedRunId` skips `StateCorruptionError` runs (a
  corrupt run can't be opened anyway) so the offer reaches the newest *openable* finished run.

## What remains in Phase 2 (gated real-CLI / full-host assertions — no new product code)

All Phase 2 implementation units (U4–U7) are landed. The remaining items are **observable
assertions** on U6 behavior that already works at the state/runner-boundary level, best landed at
the gated real-CLI / full-host level:

- **AT-2 / AT-3** — the **rendered** interactive failure footer via a real `orch resume` full-host
  fake-agent scenario (footer affordances are already model-covered).
- **AT-R5** — a prompt-recording fake runner asserting the configured instruction is handed in,
  plus real fork/session-resume (Claude `--resume --fork-session`; Codex rollout-copy).
- **AT-R10 / AT-R10a** — cross-invocation reopen after a CLI retry (load cleanly, correct view, tee
  coherent), including the quit-before-continue KTD-8 parked-state case.
- **AT-R11** — cmux pill `failed → completed` on a real `[c]` continue (path wired; cmux-surface
  assertion pending, gate with `ORCH_DISABLE_CMUX`).
- **AT-18 / AT-19 (failed half)** — `⏎`-inspect-in-failed-view is pure.
- **AT-11 (failed half)** — bare→confirm→`openFailed` end-to-end open (needs a real workflow on
  disk; the routing reuses the open-failed.test.ts-proven loop).

Then **Phase 3 (U8 — `orch retry` verb)** is entirely not-started; its host-free seam
(`runResumeExecution`) is already pinned by U6.

## Surprises / notes for reviewers

- **No surprises in U7.** It is the cheap, self-contained slice the plan promised: the
  `ConfirmService` seam, the view-opening primitives (`openFinished`/`openFailed`), and the
  resumable scan all already existed — U7 is the routing + status-distinguishing copy that wires
  them together. The only refactor was splitting `resolveResumeTarget` so the fallback reuses the
  validated loader rather than duplicating the corruption/`workflowName` checks.
- **Phase 2 is deliberately still in-progress.** Marking it `done` would over-claim: U6 owns
  several ATs whose *observable* assertions (rendered footers, cross-invocation, cmux pill, real
  fork) are still pending at the gated level, exactly as rounds 1–4 flagged. The implementation
  surface is complete; the verification surface is not. This is honest, not a regression.

## Blockers

None. No blocker file written. The brainstorm's assumptions held: the status-aware fallback was
buildable on the existing `ConfirmService` (KTD-3 confirmed — no new prompt service) and the
already-built `openFinished`/`openFailed` primitives, with no schema migration.
