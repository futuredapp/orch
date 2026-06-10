# Plan-review findings — applied vs rejected

Source: `docs/sessions/resume-completed-session/plan-review.md`, cross-checked against the acceptance
contract (`brainstorm.md` D1–D8, `acceptance-tests.md` AT-1..22 / AT-R1..R11). Each finding was kept
only where it genuinely tightens the plan without expanding scope past the brainstorm. No blocker was
raised — no finding contradicts a brainstorm assumption fatally; all are gaps/clarifications.

## Finding 1 — Retry-only success has no defined persisted state (critical) — APPLIED

Real gap: AT-R1 creates an in-between state ("`[r]` passed, parked before later steps") the plan
left undefined, and AT-R10 depends on it. Added **KTD-8**: the parked state is migration-free —
`status` stays `failed`, only the failed step's attempt-state flips to success, and
`projectStepsView`/`finalizeView` re-derives "retried-ok, continue available" from step-level state.
Wired into U5 (single-step persisted outcome), U6 (goal), and the System-wide-impact "no schema
migration" line. Kept the existing schema (no new run status) per the brainstorm's "no migration"
intent, with an explicit flag-it escape hatch if the step model genuinely can't carry the outcome —
so this pins the contract without inventing a state machine.

## Finding 2 — Instruction source doesn't fully satisfy D7 / sibling D3 (high) — PARTIALLY APPLIED

Applied: clarified in **KTD-4**/U4 that retry (`[r]`) and continue (`[c]`) are *distinct kinds*
(D7 names both) resolving through `resolveInstruction(kind, configured?)`, both defaulting to
`'continue'` until a schema exists — a small, real hardening that lets the sibling supply distinct
values later without re-threading. Also stated explicitly that the configured-default *delivery*
(AT-R5) is what this feature owns.

Rejected: building separate config values, step/workflow/default precedence, and the interactive
*typed-override input UI*. The brainstorm **Non-goals** explicitly defer "the configured
retry/continue instruction *schema*" to the sibling, and D7's typed-override is "same TUI as the
sibling." Implementing it here would expand scope into the sibling's feature. Instead the plan now
names the override as a deliberate, sibling-owned out-of-scope item.

## Finding 3 — Phase 1 "ships standalone value" while `failed` stays unsafe (high) — APPLIED

Valid: shipping the completed branch alone leaves `orch resume <failed-id>` silently re-running (the
exact surprise this feature removes — D2/D3/D6, AT-2, AT-R4, AT-20). Reworded Phase 1 as a
*completed-only* slice with an explicit **rollout boundary**: not to be announced/documented as
"finished-run re-entry" until U6 flips the failed path (and U7 for bare resume). Kept the
implementation phasing. Adopted the finding's interim-guard idea only as an *optional, owner-approved
variant* (refuse explicit `failed`, never silently re-run) — not a default — to avoid adding a
feature-flag mechanism the plan doesn't need.

## Finding 4 — Headless `orch retry` needs an explicit non-TUI path (medium) — APPLIED

Concrete correctness fix for AT-R8 (CI-hang / copied-refusal risk). U8 now splits TTY vs no-TTY
explicitly: no-TTY calls a **host-free** `retryAndContinue(runId, instructionSource)` core — no
two-pane host, action channel, `ConfirmService`, override UI, or shutdown plumbing. Pinned that seam
in U6's files, and added an AT-R8 no-host-construction guard test (spies on host factory +
`ConfirmService`).

## Finding 5 — Actioned side effects under-specified vs pure-open (medium) — APPLIED

Added an **actioned side-effects matrix** at the top of Phase 2 fixing the observable boundaries
(`status`, `run:ended` on/off, cmux pill, logs, exit) for every action/outcome: `[r]` pass-park,
`[r]` fail-again, `[c]` complete, `[c]` fail-again, `orch retry` complete/fail-again. Left exact
event *names* to implementation (as the finding allows); fixed only the observable on/off, anchored
to KTD-8 and AT-R11/AT-16.

## Finding 6 — Coverage claim misses two behaviors (medium) — PARTIALLY APPLIED

Applied: added **AT-R10a** (`[r]` success → quit → reopen) as a plan-added U6 scenario — it
exercises the KTD-8 parked state AT-R10 doesn't force. Added it to the coverage map.

Rejected: AT-R5a (interactive typed-override delivered). Consistent with Finding 2 — the override UI
is sibling-owned/out-of-scope, so requiring a test for it would contradict the Non-goals. Instead
added a Test-strategy *scope note* stating the override is deliberately unimplemented/untested here,
so the plan no longer over-claims exhaustive coverage.

## Finding 7 — "Blocked-on-user-input" contains non-blockers (low) — APPLIED

Moved the confirmation-copy (Phase 2) and `ResumeError` rename (Phase 3) items into a new
**Implementation choices** subsection per phase, and left "Blocked-on-user-input: None" — preserving
the required AI-vs-user-input separation on every phase while making it accurate.

## Scope discipline

Net additions are clarifications (one new KTD, one matrix, one plan-added test, two
implementation-choice relabels) — no new units, no new runtime surface, no schema migration, and the
sibling's instruction-schema/override remain explicitly out of scope per the brainstorm Non-goals.
