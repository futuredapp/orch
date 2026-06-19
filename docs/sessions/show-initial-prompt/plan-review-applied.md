# Plan Review — Applied

Reconciliation of `docs/sessions/show-initial-prompt/plan-review.md` against the
acceptance contract (`docs/sessions/show-initial-prompt/brainstorm.md` +
`docs/sessions/show-initial-prompt/acceptance-tests.md`). Each finding below was
double-checked against the contract and the codebase before deciding. Edits were
made in place in `docs/sessions/show-initial-prompt/plan.md`; `Status:` lines and
the AI-implementable / Blocked-on-user-input separation are preserved on every
phase.

No blocker was raised — every finding is resolvable within the existing scope.

## Applied

### F1 — File-tail backfill can truncate the prompt (high) — APPLIED
Verified in code: `file-tail` sources spawn `tail -n 5000 -F`
(`TAIL_BACKFILL_LINES`, `src/hosts/two-pane/pane-map/right-pane-controller.ts:72,368`).
A prompt+output stream past 5000 lines drops the head, directly violating R2/AT-5
("no truncation") and AT-9 ("open at top"). Added **KTD8** (from-start read —
`tail -n +1 -F` — for prompt-bearing live + replay sources only), a grounding
bullet, a from-start flag on the `file-tail` `PaneSpec` (added `pane-spec.ts` to
the file list and U4's files), an over-backfill regression scenario in U4 (with a
focused-unit substitute allowed if a 5000-line full-host run is too slow), and a
Risks note. Note the acceptance docs assumed "tee path is unbounded"; the plan now
makes that assumption true rather than contradicting it.

### F2 — Phase 1 overclaims replay/R8 completion (medium) — APPLIED
The contract pins R8 to an always-on store independent of file logging. Reworded
Phase 1 to cover R1–R7 + AT-1/2/3/4/5/6/8 as acceptance-closing, and the logging-on
replay as an explicit **interim regression** (not R8/AT-7 acceptance). Renamed
Phase 2 to "R8 / AT-7 acceptance" (was "R8 hardening"), reframed its intro,
re-pointed the traceability table's AT-7 row to Phase 2 with Phase 1 as a sub-row
interim, and updated the U4 AT-7 scenario label and the Risks note.

### F4 — Escaper needs a precise Unicode boundary (medium) — APPLIED
Verified `stripAnsi` operates on a JS string via regex over code points, so naive
UTF-8 byte escaping of `0x80–0x9F` would corrupt multi-byte non-ASCII text.
Rewrote KTD3 and U1 to specify a **code-point** escaper over the prompt string
(U+0000–U+001F except LF/TAB, U+007F, U+0080–U+009F, ESC; all other Unicode
preserved), added a grounding bullet, and added a U1 test scenario proving
non-ASCII text survives while embedded controls are escaped.

### F5 — Always-on prompt store too implementation-loose (medium) — APPLIED
Pinned the persistence contract in KTD7/U5 instead of leaving "dedicated file OR
StepEntry field" open: a `stateDir`-rooted (not `logsDir`-rooted) dedicated
`agents/<step>/prompt.txt`, raw body, written unconditionally; `StepEntry` holds a
relative pointer at most, never the body. Added U5 test assertions (path rooted in
`stateDir` when logging is disabled; prompt body absent from `state.json`) and
updated Phase 2's Blocked-on-user-input note to reflect the now-pinned choice.

### F6 — AT-9 needs a way back to live output (low) — APPLIED
Added a U7 guard scenario: after the pane opens at `prompt:` on an over-height
step, drive follow-live / scroll-to-tail and assert the latest agent output
becomes visible, so the top-pin does not strand the watcher. Framed as an
edge-case usability guard, not a new acceptance gap (AT-9 itself only requires
opening at the top). Updated U7's verification line accordingly.

## Rejected

### F3 — Don't carry interactive prompts on real interactive lifecycle events (medium) — REJECTED
**Reason: it contradicts the human-reviewed acceptance contract.** acceptance-tests.md
AT-4 (and the "Unwired-feature triage" note) explicitly require AT-4 to *fail* if
the autonomous-only guard is dropped — "not pass vacuously because interactive
steps happen to take a separate code path that never calls the injector." If the
prompt is not carried on interactive `step:start` events, dropping the guard leaks
nothing (no prompt to render), so AT-4 would pass vacuously — exactly the failure
mode the contract forbids. The finding's privacy/surface-area concern is real but
bounded: KTD2 already strips the prompt from the structured lifecycle record and
Phase 2's always-on sink writes for autonomous steps only, so the prompt stays an
in-memory event field, never persisted for interactive steps. Added a clarifying
note to U2 documenting this rationale and the rejected alternative.
