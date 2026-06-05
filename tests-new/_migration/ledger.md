# Migration ledger — old → new accounting (D15)

> **Per-CASE accounting.** A file is wrapped `.skip` only once **every** child
> `it()`/`test()`/`it.each` row is mapped here to a disposition. Every row is
> keyed to the **frozen** baseline (`baseline.json`, D12). `oldTestRefs` on the
> new scenario must back-reference the old case so the U14 reconciliation closes
> the loop.
>
> **Dispositions:** `port` (re-derived 1:1-ish), `merge` (folded into another
> scenario), `demote` (moved to a cheaper category — e.g. full-host → screen),
> `drop` (deleted with reason — a vacuous/unprovable assertion), `new` (born in
> `tests-new/` with **no** baseline twin — tagged so reconciliation does not flag
> it as an unaccounted relocation; parent §U3 during-migration routing rule).
>
> **Status (parent U4 — migration tracer).** U4 migrates the first two feature
> areas (`launch` + `follow-live`) end-to-end and is the first phase to mark old
> files `.skip`. The overlap report is **blocking** as of U4. The eight
> wholly-in-area old files below are now fully skipped with `// MIGRATED →`
> markers; every child case has a row. Multi-area files (bulk left-pane
> rendering, pane-map/right-pane-controller, the behavioral-dsl launcher smoke)
> stay live for U5–U8 — skipping them before every case is ledgered is the
> green-but-incomplete trap D15 exists to prevent.
>
> **K2 vs K2-alt (parent U4 §4).** The phase took the **K2** path: the
> `single-pane-steps-entry` was made interactive (holds `view` in state, updates
> from `onIntent`), so `selectStep`/`followLive` drive a real selection change
> over real tmux on the `screen` driver — the footer-flip twin uses genuine
> navigation, not a synthetic `viewMode`.

## Migrated cases — `launch` + `follow-live` (parent U4)

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| tests/integration/hosts/two-pane/tier-1/follow-live-returns-to-running-step.real.integration.test.ts | press F after navigating to a past step swaps right pane back to the live source | full-host/fake-agent/follow-live--keypress-during-stream.test.ts (+ model/follow-live--returns-to-running-step.test.ts) | port | Deferred placeholder (it.skip): the live-driven scriptedFake submode is the paused-workflow hook it waited for; now a real mid-stream interleave. |
| tests/integration/hosts/two-pane/tier-1/view-mode-footer-reflects-mode.real.integration.test.ts | after the workflow completes, the left pane renders the terminal-state footer and the workflow name | screen/follow-live--footer-flips-live-to-replay.test.ts (+ screen/launch--header-and-step-list-render.test.ts) | demote→screen | Terminal-state footer + workflow-name render is a byte-level risk (screen), not full-host plumbing (§6). |
| tests/integration/hosts/two-pane/tier-1/autonomous-live-pane-shows-content.real.integration.test.ts | right.waitForText resolves before its timeout, both transcript lines are visible, and no caret-notation echo bytes appear | full-host/fake-agent/follow-live--right-pane-swaps-source.test.ts (+ follow-live--keypress-during-stream.test.ts) | port | Autonomous transcript reaching the visible right pane with no caret echo — two-pane communication risk (full-host). |
| tests/unit/hosts/two-pane/steps-view/view-mode-footer.test.tsx | live mode renders '▶ live · ⏎ view step · q quit · ? help' | screen/follow-live--footer-flips-live-to-replay.test.ts | demote→screen | Live-footer bytes (assertFollowLiveHintHidden) — proven off real tmux, not a projection. |
| tests/unit/hosts/two-pane/steps-view/view-mode-footer.test.tsx | replay mode renders '⏸ viewing <stepName> · f live · ⏎ view another' | screen/follow-live--footer-flips-live-to-replay.test.ts | demote→screen | Replay-footer bytes (assertFollowLiveHintVisible) — proven off real tmux. |
| tests/unit/hosts/two-pane/steps-view/view-mode-footer.test.tsx | flipping state from live → replay re-renders the footer indicator | screen/follow-live--footer-flips-live-to-replay.test.ts | port→screen | The flip is now driven by REAL navigation (selectStep → replay, followLive → live), a stronger assertion than swapping a prop. |
| tests/integration/hosts/two-pane/follow-live-prefers-live-over-interactive-replay.integration.test.ts | after entering a past interactive step replay, pressing follow-live swaps the visible slot back to the live autonomous source | model/follow-live--prefers-live-over-interactive-replay.test.ts | port→model | Follow-live-over-replay is a controller DECISION, re-derived at the projection seam (no tmux). |
| tests/integration/lifecycle/launch.workflow-header-and-step-list-render.behavioral.real.test.ts | renders workflow name, step row, and live-mode footer in the left pane | screen/launch--header-and-step-list-render.test.ts (+ model/launch--header-and-step-list-render.test.ts; lifecycle boot → lifecycle/launch--boots-to-mid-step-and-tears-down.test.ts) | demote→screen | Header/step-row/footer is rendering bytes (screen) + projection (model); the lifecycle boot/teardown concern keeps its own scenario (§6, K4). |
| tests/integration/lifecycle/launch.first-step-is-running-and-highlighted.behavioral.real.test.ts | shows the running glyph on the first step and the live source in the right pane | model/launch--first-step-running-and-highlighted.test.ts + screen/launch--first-step-running-and-highlighted.test.ts + full-host/fake-agent/follow-live--right-pane-swaps-source.test.ts (+ lifecycle boot) | port | One old case splits by risk: glyph+highlight (model), glyph bytes (screen), live source in right pane (full-host), boot (lifecycle). |
| tests/integration/lifecycle/launch.interactive-badge-renders-on-interactive-step.behavioral.real.test.ts | renders the interactive glyph on an interactive step | — | drop | Blocked `it.todo` that never executed (scripted-fake has no interactive mode); asserted nothing. Re-derive when an interactive/PTY-capable fake runner exists (parent U9/recorded). |

## Backfill — U2/U3 tracers that already pointed at migrated baseline files

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| tests/integration/hosts/two-pane/tier-1/follow-live-returns-to-running-step.real.integration.test.ts | press F after navigating to a past step swaps right pane back to the live source | model/follow-live--returns-to-running-step.test.ts | port | U1 model tracer (the `follow-live-view-mode` model member); shares the case ported above — its model half. |
| tests/integration/hosts/two-pane/tier-1/view-mode-footer-reflects-mode.real.integration.test.ts | after the workflow completes, the left pane renders the terminal-state footer and the workflow name | screen/follow-live--footer-renders-with-quit-hint.test.ts | demote→screen | U2 screen tracer (the `follow-live-view-mode` screen twin); quit-hint footer bytes, same case demoted above. |
| tests/integration/hosts/two-pane/tier-1/autonomous-live-pane-shows-content.real.integration.test.ts | right.waitForText resolves before its timeout, both transcript lines are visible, and no caret-notation echo bytes appear | full-host/fake-agent/follow-live--right-pane-swaps-source.test.ts | port | U2 full-host tracer; the same right-pane-content case ported above.

## Born-new (no baseline twin) — parent U3 tracers

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| — | — | full-host/recorded-agent/claude-plan-then-work.test.ts | new | born in tests-new/ (parent U3 tracer); no old twin — realistic-event replay had no equivalent under the old harness |
| — | — | full-host/real-agent/autonomous-multi-step.test.ts | new | parent U3 real-CLI smoke; re-derives the spirit of tests/e2e/tier-4 as a two-pane pane-integration assertion, not a runner-isolation test |

## Migrated cases — left-pane logic & rendering (parent U5a)

> **Phase 5 / U5a** re-derives the left-pane *interaction & rendering* cluster
> (selection, preview cursor, scroll/viewport, step glyphs + colour) as `model`
> projection scenarios with co-landed `screen` byte twins under shared
> `overlapGroup`s. Two files are **fully** ported and now `.skip`; the rest are
> **spans/partial** — their U5a cases are ledgered here but the FILE stays live
> until its remaining (footer/banner/summary → U5b; pure-projection → U10–U13;
> failed/pending/interactive/cached colour → U8/U10–U13) cases land. Skipping a
> file with un-ledgered children is the green-but-incomplete trap D15 forbids.

### Fully ported → file `.skip`

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| steps-view/selection.test.tsx | auto-tracks the live step on first render with isUserDriven=false | model/selection--auto-tracks-live-and-browses.test.ts (+ screen/selection--highlight-bytes.test.ts) | port | Committed highlight auto-tracking the live step is a projection decision; byte twin proves the `▌` highlight renders. |
| steps-view/selection.test.tsx | moves selection up when the user presses arrow-up and flips isUserDriven=true | model/selection--auto-tracks-live-and-browses.test.ts | port | `browseTo` drives a real ↑ keystroke and asserts the preview cursor moved while committed held. |
| steps-view/selection.test.tsx | moves selection down when the user presses arrow-down | model/selection--auto-tracks-live-and-browses.test.ts | merge | `browseTo` is bidirectional — it emits ARROW_DOWN when the target row is below the cursor; the down branch is exercised by the same affordance. |
| steps-view/selection.test.tsx | snaps back to live and clears isUserDriven when the user presses f | model/selection--auto-tracks-live-and-browses.test.ts | port | `followLive` snaps the committed selection back to the live step. |
| steps-view/preview-cursor.test.tsx | moves a distinct preview cursor on ↑ while leaving the committed highlight on the live step | model/preview-cursor--browse-commit-snap.test.ts (+ screen/preview-cursor--bytes.test.ts) | port | The `›` preview cursor moves while the `▌` committed row holds — proven at the seam and off real tmux. |
| steps-view/preview-cursor.test.tsx | does not draw a preview cursor when it coincides with the committed row | model/preview-cursor--browse-commit-snap.test.ts | merge | The driver's `previewCursorStepName` vs `highlightedStepName` split depends on the suppression; after `followLive` the cursor returns to the committed row and no separate `›` is reported. |
| steps-view/preview-cursor.test.tsx | commits the previewed step (not the committed row) on Enter | model/preview-cursor--browse-commit-snap.test.ts (+ screen twin) | port | `selectStep` previews then commits the chosen step. |
| steps-view/preview-cursor.test.tsx | snaps the preview cursor back to the committed row on f | model/preview-cursor--browse-commit-snap.test.ts | port | `followLive` snaps preview+committed back together. |

### Spans / partial — case ledgered in U5a, file stays LIVE

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| steps-view/steps-view-scroll.test.tsx | (viewport-window scroll cases) | model/scroll--viewport-follows-window.test.ts (+ screen/scroll--window-bytes.test.ts) | port | Off-window step scrolls into view and back to the live tail (model window + screen bytes). The file's footer/scroll-indicator cases route to U5b — file stays live. |
| steps-view/steps-view-colors.test.tsx | renders a green check for completed steps | model/glyph--state-and-color.test.ts (+ screen/glyph--state-and-color-bytes.test.ts) | port | `done` → ✓ green, asserted via the co-located COLOR token (D-P4) on both fidelities. |
| steps-view/steps-view-colors.test.tsx | renders a yellow half-circle for running steps | model/glyph--state-and-color.test.ts (+ screen twin) | port | `running` → ◐ yellow (D-P4). |
| steps-view/steps-view-colors.test.tsx | (red-cross / dim-pending / cyan-selection / preview-chevron / interactive / cached / stripAnsi-structure cases) | — | →U8/U10–U13 | failed-glyph colour belongs to the failure cluster (U8); selection-cyan/preview-chevron/pending/interactive/cached and the stripAnsi structural snapshot are per-status render cases the U5 spec does not yet express — file stays LIVE, deferred. |
| steps-view/adaptive-columns.test.ts | hides elapsed below width 70 and exposes it from 70 upward across the canonical breakpoints | screen/columns--elapsed-threshold.test.ts | port→screen | Adaptive-column hide/show is a render byte risk (elapsed `500ms` drops below 70), proven off real tmux. |
| steps-view/adaptive-columns.test.ts | exposes the documented threshold constants … | — | demote→unit | Pure `COLUMN_THRESHOLDS` policy assertion (D-P6) — relocates as a plain unit test in U10–U13; file stays live. |
| steps-view/steps-view.test.tsx | keeps hairlines and drops the elapsed column on narrow terminals (<70 cols) | screen/columns--elapsed-threshold.test.ts | port→screen | The narrow-width column drop is covered by the screen columns twin. Remaining steps-view.test.tsx cases (header/keymap/end-of-run footer/banner/onKey) span U5b + key-mechanics — file stays live. |

## Migrated cases — view-mode footer · banner · end-of-run (parent U5b)

> **Phase 5 / U5b** re-derives the rendering-dominant cluster (view-mode footer
> hints, banner paint + virtual-clock TTL, end-of-run summary/footer/count/colour).
> Banner TTL is `model`-only on the virtual clock (D-P2 — a `screen` test must
> never wait wall-clock); every other behaviour co-lands a `model` decision and a
> `screen` byte twin under a shared `overlapGroup`. Four steps-view files + one
> tier-1 integration case are fully covered and now `.skip`. The larger
> `steps-view-banner.test.tsx` (Esc/help keymap mechanics) and the pure
> `tui-overlay.test.ts` parser stay live (deferred — see below).

### Fully ported → file `.skip`

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| steps-view/banner-rendering.test.tsx | info banner text appears in the frame | model/banner--info-and-error-paint.test.ts (+ screen/banner--paint-bytes.test.ts) | port | Info banner text paints (decision + bytes). |
| steps-view/banner-rendering.test.tsx | error banner text appears in the frame | model/banner--info-and-error-paint.test.ts (+ screen twin) | port | Error banner paints in the `! … · Esc dismiss` envelope. |
| steps-view/banner-rendering.test.tsx | no banner field → no banner row in the frame | model/banner--info-and-error-paint.test.ts | port | Pre-emit `assertContentAbsent` proves no banner row. |
| steps-view/end-of-run-footer.test.tsx | completed terminal status shows the run-completed footer | model/end-of-run--summary-and-count.test.ts (+ screen twin) | port | `assertTerminalFooterVisible('completed')`. |
| steps-view/end-of-run-footer.test.tsx | failed terminal status shows the run-failed footer | model/end-of-run--summary-colors.test.ts | port | `assertTerminalFooterVisible('failed')`. |
| steps-view/end-of-run-footer.test.tsx | crashed terminal status shows the run-crashed footer | model/end-of-run--summary-colors.test.ts | port | `assertTerminalFooterVisible('crashed')`. |
| steps-view/end-of-run-footer.test.tsx | pre-terminal (status: live) keeps the live footer indicator | model/footer--view-mode-hints.test.ts (+ screen twin) | port | Live mode shows the view-step/help hints, no `f live`. |
| steps-view/end-of-run-summary.test.tsx | repaints the header into a summary block on completion (totals + duration) | model/end-of-run--summary-and-count.test.ts (+ screen twin) | port | `assertEndOfRunSummaryShows('duration')` + completion count. |
| steps-view/end-of-run-summary.test.tsx | renders distinct labels for failed and crashed terminal states | model/end-of-run--summary-colors.test.ts | port | Failed/crashed footers + summary colours co-asserted. |
| steps-view/end-of-run-summary.test.tsx | leads with "q to quit · ⏎ to inspect" and includes the run status | model/end-of-run--summary-and-count.test.ts (+ screen twin) | port | `assertTerminalFooterVisible` pins the co-located footer copy. |
| steps-view/end-of-run-summary.test.tsx | keeps Enter wired so resume on a past interactive step still fires onIntent | model/end-of-run--summary-and-count.test.ts | port | `selectStep` commits in the terminal state. |
| steps-view/end-of-run-summary.test.tsx | renders the same frame on a re-render with an unchanged terminal state (no flicker) | — | drop | Re-render stability is a React-memo concern; the deterministic capture is already stable and flicker hygiene (clearTerminal inspection) is not expressible at the projection seam — covered structurally by the stable byte twin. |
| steps-view/end-of-run-summary-colors.test.tsx | renders the "completed" label in green | model/end-of-run--summary-colors.test.ts (+ screen twin) | port | `assertSummaryColor('completed')` via the co-located COLOR token (D-P4). |
| steps-view/end-of-run-summary-colors.test.tsx | renders the "failed" label in red | model/end-of-run--summary-colors.test.ts (+ screen twin) | port | `assertSummaryColor('failed')`. |
| steps-view/end-of-run-summary-colors.test.tsx | renders the "crashed" label in red | model/end-of-run--summary-colors.test.ts | port | `assertSummaryColor('crashed')`. |
| steps-view/end-of-run-summary-colors.test.tsx | does not color the run header text (only the status word) | model/end-of-run--summary-colors.test.ts | merge | `assertSummaryColor` targets the status word; the co-located COLOR maps only glyph/summary states, so the header breadcrumb carries no colour token — the positive assertion is the spec. |
| tier-1/end-of-run-summary-visible.real.integration.test.ts | left.capture() contains `run completed` footer and `steps 1/1 completed` summary | screen/end-of-run--summary-and-count-bytes.test.ts | demote→screen | Left-pane end-of-run bytes are a single-pane `screen` risk, not full-host plumbing. |

### Spans / partial — case ledgered in U5b, file stays LIVE

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| steps-view/steps-view-banner.test.tsx | renders ▶ live · ⏎ view step · q quit · ? help in live mode (no `f live` token) | model/footer--view-mode-hints.test.ts (+ screen twin) | port | Live footer hints + `assertFollowLiveHintHidden`. |
| steps-view/steps-view-banner.test.tsx | renders ⏸ viewing <stepName> · f live · … in replay mode | model/footer--view-mode-hints.test.ts (+ screen twin) | port | `assertViewingHintVisible` + `assertFollowLiveHintVisible` after a real selection change. |
| steps-view/steps-view-banner.test.tsx | renders an info banner above the steps grid | model/banner--info-and-error-paint.test.ts (+ screen twin) | merge | Same info-banner paint behaviour. |
| steps-view/steps-view-banner.test.tsx | renders an error banner with an Esc-dismiss hint | model/banner--info-and-error-paint.test.ts (+ screen twin) | merge | The `! … · Esc dismiss` envelope is co-located and asserted. |
| steps-view/steps-view-banner.test.tsx | dispatches dismiss-banner for an info banner after ttlMs elapses | model/banner--info-clears-error-persists.test.ts | port | Info auto-clears on the virtual clock (D-P2). |
| steps-view/steps-view-banner.test.tsx | does NOT auto-dismiss an error banner regardless of ttlMs | model/banner--info-clears-error-persists.test.ts | port | Error persists past `advanceTime`. |
| steps-view/steps-view-banner.test.tsx | (truncate long stepName; Esc help-open/closed/no-banner mechanics; info-not-manually-dismissable; seq-restart; keymap list) | — | →U6/U10–U13 | Esc/help keymap mechanics + footer truncation + the seq-restart timer detail are low-level keymap/render concerns the U5 surface does not express; file stays LIVE, deferred. |
| steps-view/tui-overlay.test.ts | (all 11 parse/serialize cases) | — | demote→unit | `parseTuiOverlayLine`/`serializeTuiOverlayLine` are pure model-state codec tests, not left-pane rendering (D-P6/triage) — relocate as plain unit tests in U10–U13; file stays live. |
| lifecycle/banner.info-banner-auto-clears-after-ttl.behavioral.real.test.ts | the "step complete" info banner is visible briefly then disappears | model/banner--info-clears-error-persists.test.ts | demote→model | Banner TTL is a decision over time — proven deterministically on the virtual clock, never real wall-clock (D-P2/D-P3). File is a lifecycle-cluster file; left live for U8 to close its boot/teardown concern. |
| lifecycle/banner.error-banner-persists-until-escape.behavioral.real.test.ts | error banner stays visible past the info-TTL and dismisses on Esc (blocked it.todo) | model/banner--info-clears-error-persists.test.ts | demote→model | The persist-past-TTL half is now covered at the model seam; the Esc-dismiss half was a never-executed `it.todo`. File left live for U8. |
