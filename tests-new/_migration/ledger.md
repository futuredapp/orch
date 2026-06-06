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

> **Note (parent U9/W4).** The U3 `full-host/real-agent/autonomous-multi-step.test.ts`
> smoke was born `new` but is, in substance, the re-derivation of the tier-4
> `autonomous-multi-step` case. U9 retargets its `oldTestRefs` to the specific old
> file and reclassifies it as a `port` in the tier-4 section below — so the case
> maps to exactly one disposition (no double-count).

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

## Migrated cases — two-pane plumbing: nav · replay · progression · multi-source (parent U6)

> **Phase 6 / U6** migrates the two-pane *plumbing* surface — behaviours whose
> risk is *what the controller decides about the panes* or *whether the two panes
> communicate* — re-derived across `model` (decisions) and `full-host:fake-agent`
> (communication), plus a `screen` byte twin for the one net-new rendering
> surface (the help overlay). It is a **pruning** re-derivation: several nominal-U6
> files answer "yes" to the triage rule ("would this still pass if the pane were
> empty?") — their risk is orchestration / disk persistence / a race, not the
> panes — so they are `demote→integration` (relocated in U10–U13), file left LIVE.
>
> The new full-host nav/replay/multi-step scenarios run in **static** mode (the
> whole FakeRunner workflow runs to completion, then navigation drives the
> mounted host), which sidesteps the U4 live single-handle multi-step limit.

### Sub-phase U6a — navigation & replay → file `.skip`

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| lifecycle/nav.help-overlay-opens-and-closes.behavioral.real.test.ts | ? opens the keymap overlay, Esc closes it, the step list survives | model/help-overlay--opens-and-closes.test.ts (+ screen/help-overlay--paint-bytes.test.ts) | port | New help-overlay affordance (U6a.1): controller-shows decision (model) + overlay bytes paint without eating the step list (screen), overlapGroup `help-overlay`. Closes the U5b-deferred Esc/help keymap mechanics. |
| lifecycle/nav.up-down-moves-selection-without-detaching-live.behavioral.real.test.ts | ↑/↓ moves the preview cursor while the running step keeps live focus | model/nav--up-down-keeps-live-running.test.ts | port→model | Selection decoupled from live focus is a controller decision (no byte risk) — re-derived at the projection seam. |
| lifecycle/nav.enter-on-completed-step-swaps-right-pane-to-transcript.behavioral.real.test.ts | Enter on a completed step swaps the right pane to its transcript | full-host/fake-agent/nav--enter-swaps-right-pane-to-transcript.test.ts | port | Two-pane communication: revisiting a completed step swaps the visible right pane to that step's source (proven via the deterministic per-source `[<step>] starting…` marker; the live↔replay footer-flip chrome is covered by the U5b `view-mode-footer` model/screen scenarios in live mode). |
| lifecycle/nav.f-snaps-selection-back-to-live.behavioral.real.test.ts | f returns the committed selection to the live step | model/follow-live--returns-to-running-step.test.ts (+ model/selection--auto-tracks-live-and-browses.test.ts, U5 footer twins) | merge | Same follow-live decision already covered by the U4 follow-live group; added `oldTestRefs`. No distinct right-pane outcome to warrant a new full-host twin. |
| tier-1/replay-shows-same-transcript-as-live.real.integration.test.ts | the transcript persists in the right pane after the run ends | full-host/fake-agent/replay--revisit-shows-same-transcript.test.ts | port | Single-step transcript persistence is deterministic; two-pane communication. |
| tier-1/replay-revisit-reuses-pane.real.integration.test.ts | the per-source session pane count is stable across two right-pane captures after step:complete | full-host/fake-agent/replay--revisit-shows-same-transcript.test.ts | port (visible) + drop (pane-count) | VISIBLE half (revisit shows the same transcript) ported; the white-box per-source pane-COUNT invariant is `drop` — an implementation detail, not a user-visible outcome, covered structurally by the U2 driver no-orphans/teardown regression. |
| tier-1/multi-step-right-pane-shows-latest.real.integration.test.ts | after the first step completes, the right pane auto-advances to the second live step while the first stays warm-cached | full-host/fake-agent/multi-step--right-pane-auto-advances.test.ts | port | Right-pane auto-advance + warm-cache revisit (two-pane plumbing), asserted via the deterministic per-source marker. |
| tier-1/interactive-pane-shows-prompt.real.integration.test.ts | (single it.skip deferred placeholder — never executed) | — | drop | Deferred placeholder (`it.skip`) that never ran and asserted nothing. The interactive *badge* render is covered by U4 `launch.interactive-badge`; real interactive prompt BYTES belong to a U9 `real-agent` smoke if desired. File becomes `describe.skip`. |

### Sub-phase U6b — progression, multi-source, command, demotions

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| lifecycle/progression.live-focus-follows-newly-running-step.behavioral.real.test.ts | the live focus follows the newly-running step after the prior completes | model/progression--live-focus-and-glyph-flip.test.ts | port→model | Controller decision: committed selection auto-tracks the newest running step (overlaps U5 selection-auto-tracks-live). |
| lifecycle/progression.step-completes-glyph-flips-to-check.behavioral.real.test.ts | a completed step's glyph flips to the done check | model/progression--live-focus-and-glyph-flip.test.ts | port→model | Glyph-flip decision (the colour bytes already have a `screen` twin in U5 `glyph--state-and-color`). |
| tier-1/many-sources-no-split-failure.real.integration.test.ts | runs 6 autonomous steps back-to-back; each lands in its own per-source session and the right pane shows the latest | full-host/fake-agent/multi-source--each-source-swaps-distinct-content.test.ts | port | Consolidated at representative scale (3 sources): each per-source step lands in its own session; right pane auto-advances to the latest. |
| tier-1/many-sources-no-split-failure.real.integration.test.ts | captures different pane content after swapping the visible slot across six sources | full-host/fake-agent/multi-source--each-source-swaps-distinct-content.test.ts | port | Swapping the visible slot shows each source's distinct content. |
| lifecycle/per-source-sessions-10-step-walkthrough.real.test.ts | runs 10 autonomous steps; no pane-spawn-failed or scratch-window-rotate events fire; teardown reaps every per-source session | full-host/fake-agent/multi-source--each-source-swaps-distinct-content.test.ts | port (swap) + merge (no-leak/teardown) | The visible swap-across-sources is ported (at 3-source scale, not a slow 10-step real-tmux run); the no-split/no-leak/teardown-reaps property is already guaranteed by the U2 driver no-orphans/teardown regression — referenced, not duplicated. |

### Sub-phase U6b — triage demotions (file left LIVE for U10–U13 relocation)

> These cases answer **yes** to the triage rule ("would this still pass if the
> pane were empty / wrong / unformatted?") — their risk is stop-channel
> coordination, disk persistence, resume orchestration, or a race, NOT two-pane
> rendering. They are `demote→integration` and **relocated in U10–U13**; U6
> leaves each file **LIVE** (capability `skipIf` unchanged), because reconcile
> rule 3 forbids a `// MIGRATED →` marker pointing at a target that does not yet
> exist. U6 must not skip these.

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| tier-1/auto-stop.real.integration.test.ts | closes itself when the stop channel is signaled, with no manual close | → U10–U13 | demote→integration | Stop-channel coordination, not rendering — passes if the pane is empty. File stays LIVE. |
| tier-1/auto-stop.real.integration.test.ts | records armed → signaled → terminated lifecycle events in order | → U10–U13 | demote→integration | Stop-channel event ordering (host-coordinator integration with fakes). File stays LIVE. |
| tier-1/auto-stop.real.integration.test.ts | resolves via pane-exit when an armed autoStop pane is manually closed, with no stop signal | → U10–U13 | demote→integration | Pane-exit race coordination, not a visible pane outcome. File stays LIVE. |
| tier-1/auto-stop.real.integration.test.ts | a step without autoStop never arms and ignores a stop-channel signal | → U10–U13 | demote→integration | Negative stop-channel coordination. File stays LIVE. |
| lifecycle/progression.per-step-artifacts-land-on-disk.behavioral.real.test.ts | writes session.json and events.ndjson for each completed step | → U10–U13 | demote→integration | Disk persistence, not rendering — passes if the pane is empty. File stays LIVE. |
| lifecycle/resume.cached-steps-replay-with-cached-glyph.behavioral.real.test.ts | cached plan survives across runs; execute re-runs and the resumed run completes | → U10–U13 | demote→integration | Resume orchestration (cached-plan survival, runner re-invocation). The cached-glyph RENDER overlaps U8 cached-colour; the orchestration is the dominant risk. File stays LIVE. |
| lifecycle/command.output-streams-to-right-pane-and-exit-code-recorded.behavioral.real.test.ts | command stdout streams to disk and state.json records exitCode 0 | → U10–U13 | demote→integration | The OLD case asserts disk streaming + `state.json` exitCode — both persistence/orchestration ("passes if the pane is empty"). The full-host harness runs agent steps only; a non-agent command step that streams to the right pane needs host-fixture infrastructure (a `command(...)` step + tmux pipe-pane capture) that does not exist in `tests-new/_support/real-tmux/` and is beyond U6's scenario-authoring scope. The visible command-output-to-pane behaviour is deferred to whichever phase adds command-step support; the persistence assertion relocates in U10–U13. File stays LIVE. |

## Migrated cases — right-pane-controller / pane-map decisions (parent U7a + U7b)

> **`model/controller` is a non-`scenario()` category** (the `tmux-argv` precedent;
> see `tests-new/model/controller/README.md`). These cases assert controller
> DECISIONS at the `FakeTmuxService` seam — which session to swap to, what to
> write to the overlay, when to refuse to swap to a dead pane — and pass with an
> empty pane (triage rule answers **yes**). They are therefore plain `it()` tests,
> not `model`/`screen`/`full-host` scenarios, and carry no `scenario()` meta or
> `oldTestRefs` for the overlap report to check; this ledger is their accounting.
> Every relocated file imports the **same `src/` symbols** as its baseline
> original (import-path parity, parent R10). All cases ported faithfully; no
> regression-pin run-ID was pruned. The visible-swap *outcomes* these decisions
> drive were already re-derived as U6 full-host scenarios (see U7d merges below).

| Old file | Old case | New file (path) | Disposition | Reason |
|---|---|---|---|---|
| pane-map/right-pane-controller.test.ts | (all 20 cases: registerSource ×5, showSource ×4, unregisterSource ×3, follow-live auto-advance ×1, teardownSessions ×2, followLive ×3, concurrent registerSource race ×2) | model/controller/right-pane-controller-sources.test.ts (registerSource/showSource/unregisterSource) **+** model/controller/right-pane-controller-lifecycle.test.ts (auto-advance/teardown/followLive/race) | port | Controller decisions at the `FakeTmuxService` seam. Split into two files because the 700-line original exceeds the repo's 600-line test-file cap; both halves share `right-pane-controller-fixture.ts`. Regression pins r-2026-05-22-170039-0o (race) and r-2026-05-29-104450-sx (auto-advance) preserved. The visible swap is covered by U6 full-host scenarios; the *decision* (which session) stays here. |
| pane-map/right-pane-on-intent.test.ts | (all 8 cases: warm-cache, viewMode-flip, lookup-miss, ANSI-tee preference, follow-live placeholder, live-not-replay, auto-advance-stop, interactive-stays-replay) | model/controller/right-pane-on-intent.test.ts | port | Pure `onIntent('enter')` dispatch decisions. Regression pins r-2026-05-11-215044-tv, r-2026-05-27-154145-nk, r-2026-05-29-104450-sx preserved. |
| pane-map/source-session.test.ts | (all 13 cases: sanitizeSessionName ×7, createSourceSession ×4, teardownSourceSession ×2) | model/controller/source-session.test.ts | port | Pure helper logic (relocation + import fix only). |
| pane-map/right-pane-controller-banner.test.ts | (all 6 cases: emitBanner ×3, setViewMode ×1, dismiss-banner ×2) | model/controller/right-pane-controller-banner.test.ts | port | Controller wire-format DECISION (what it writes to the overlay) — distinct from the overlay *codec* parse/serialize tests, which are U10–U13. |
| pane-map/right-pane-controller-failure-recovery.test.ts | (all 4 cases: Bug B stderr-bleed ×2, Bug C suppressCompletionBanner ×2) | model/controller/right-pane-controller-failure-recovery.test.ts | port | Error-containment decisions. Regression pins r-2026-05-21-141104-5n (Bug B) and r-2026-05-22-135756-tc (Bug C) preserved. |
| pane-map/right-pane-controller-session-lost.test.ts | (all 4 cases: register throws + no bleed, no ghost entry, unregister no bleed, canonical macOS error shape) | model/controller/right-pane-controller-session-lost.test.ts | port | Error-containment decisions. Regression pin r-2026-05-22-093650-j0 preserved. |
| pane-map/right-pane-controller-interactive-dead-pane.test.ts | (all 4 cases: no-swap to dead resume pane, swap-failure→error banner, no-swap on follow-live, recover by re-register) | model/controller/right-pane-controller-interactive-dead-pane.test.ts | port | Dead-pane decisions asserted at the fake's ownership seam (passes with an empty pane) — NOT full-host. Regression pin r-2026-05-25-171216-nu preserved. |
| pane-map/right-pane-controller-replay-dead-pane.test.ts | does-not-swap to the dead pane of a torn-down per-source session (1 case) | model/controller/right-pane-controller-replay-dead-pane.test.ts | port | Same dead-pane decision class. Regression pin Issue 3 preserved. |
| pane-map/resume-refusal.test.ts | (all 10 cases: R10, R8, R11, unsupported-runner, R9 ambiguous/empty/error, defensive no-sessionId, happy path, F6 step-keyed lookup) | model/controller/resume-refusal.test.ts | port | Branch-selection decisions. Regression pins R8–R11 / R9 / F6 preserved. |

## Migrated cases — subworkflow surface (parent U7c)

> **Triage applied per case, not per the directional table.** The old subworkflow
> tests are NOT tmux-tier tests — they are plain component/hook/projector tests
> (`projectStepsView` on pure data, `useStepsSelection` via ink-testing,
> `renderToString(<StepsView>)`). They relocate faithfully into the non-`scenario()`
> `model` / `model/projector` categories (the `tmux-argv` / `model/controller`
> precedent), needing no new scenario/driver affordances. **Scoped deviation from
> U7c.1's affordance plan:** boundary-row emission and parallel-suppression are
> proven at the projector seam (the row IS emitted); boundary-selection is a
> selection DECISION over `useStepsSelection`; the collapse gutter is the one
> genuine *rendering* case and is proven by a synchronous `renderToString` frame
> assertion. A `screen` byte twin (and the new `LeftPane`/`PaneDriver` collapse
> affordance + `overlapGroup: subworkflow-collapse`) was intentionally **not**
> built: it would add terminal-grid fidelity to a width-driven gutter that
> `renderToString` already exercises, at the cost of a risky shared-DSL extension
> touching every driver. The behaviours are fully covered; only the heavier
> scenario/byte-twin packaging is deferred (a later phase may add the screen twin
> if real-tmux gutter fidelity is ever in doubt).

| Old file | Old case | New file (path) | Disposition | Reason |
|---|---|---|---|---|
| steps-view/subworkflow-boundary-projection.test.ts | (all 8 cases: ▼/✓ between parents, additive gutter stacking, deepest-first close, in-flight stepless ▼, ✗ terminal synthesis, summary-total exclusion, sibling same-leaf separation, live-overlay subPath) | model/projector/subworkflow-boundary-projection.test.ts | port | Pure `projectStepsView` invariants on pure data. The ▼/✓ boundary-row *emission* (the row appearing) is proven here at the projection seam; no separate `model` render twin is needed (renders only what the projector emits). |
| steps-view/applySubworkflowEvent.test.ts | (all 3 cases: full-subPath keying, insideParallel preservation, invalid-event rejection) | model/projector/applySubworkflowEvent.test.ts | port | Pure fold logic (relocation + import fix). |
| steps-view/subworkflow-parallel-suppression.test.ts | suppresses sub-of-parallel (AE9); suppresses transitively (AE13); does NOT suppress sequential (negative control) | model/projector/subworkflow-parallel-suppression.test.ts | port | The 3 pure-projector suppression invariants. |
| steps-view/subworkflow-parallel-suppression.test.ts | keeps insideParallel on lifecycle records for suppressed homogeneous sub boundaries | → U10–U13 | demote→integration | Runs a real `parallel()` workflow (`parent.execute(deps)`) and asserts persisted lifecycle records — execution/persistence, NOT projection ("passes if the pane is empty"). **File stays LIVE** (reconcile rule 3: the one demote target does not yet exist). |
| steps-view/subworkflow-collapse.test.tsx | (all 4 cases: compact `│4 ` at width 50/depth 4; depth-4 boundary uses depth-3 compact form; stacked-bar at width 80/depth 4; stacked-bar at depth 3/width 50) | model/subworkflow--collapse-gutter.test.tsx | port | The genuine *rendering* case: a synchronous `renderToString(<StepsView>)` frame assertion of the compact-gutter chrome at the AE12 width/depth conditions. Plain `model` render test (no `scenario()`); the `│N ` token is the co-located spec, asserted directly. |
| steps-view/subworkflow-boundary-selection.test.tsx | (all 6 cases: ↑ skips ✓ exit→child-2; ↓ skips ✓ exit→parent-B; committedName never a boundary; ↑ no-op when only boundaries above; only-boundaries→selected=none; ⏎ on boundary emits no intent) | model/subworkflow--boundary-selection.test.tsx | port | Selection DECISIONS over `useStepsSelection` / `<StepsView>` (read hook state, pass with an empty pane). Plain `model` hook/component test via ink-testing-library. |

### U7d — crossing-panes merges (§7 discovery outcome)

> **No `oldTestRefs` merge into U6 full-host scenarios was required.** The parent
> §4 anticipated splitting some pane-map cases into a `model/controller` *decision*
> half plus a *visible-swap* half that merges into U6's
> `nav--enter-swaps-right-pane-to-transcript` /
> `multi-source--each-source-swaps-distinct-content` /
> `replay--revisit-shows-same-transcript`. In practice every old pane-map case
> asserts a controller decision at the `FakeTmuxService` seam (recorded tmux calls
> / projected state) — there is no separate visible-swap assertion embedded in any
> case to peel off — so each ported whole as a `model/controller` decision (no case
> dispositioned `merge`). The user-visible swap *outcomes* those decisions drive
> are already covered by the three U6 full-host scenarios above; no new full-host
> scenario was needed (the §7 default expectation of zero new full-host scenarios
> held). No U6 scenario file was edited.

## Migrated cases — lifecycle / outside-in (parent U8)

> **Phase 8 / U8** migrates the lifecycle / outside-in surface
> (`tests/integration/lifecycle/`) as a pruning re-derivation across four groups
> (phase plan §2): **G1** process signals/stdin/quit + **G2** click-to-focus →
> `lifecycle` `scenario()`; **G3** failure *rendering* → `model` (+ `screen`/
> `full-host` twin) using the existing `outcome:'failed'` DSL (KD3, no new
> lifecycle pane-reads); **G4** side effects / persistence → the non-`scenario()`
> `tests-new/lifecycle/side-effects/` category (KD1/KD4, the `tmux-argv` /
> `model/controller` precedent). **KD2:** signals/quit assert only the shutdown
> invariants `main` produces — no `persistedStatus('cancelled')`; on current
> `main` no signal/quit persists `cancelled` (Phase 2 finding), and U8 changes no
> source (parent §2 non-goal). The U6-deferred `command`/`progression.per-step-
> artifacts`/`resume` files stay LIVE for U10–U13.

### G1 — process signals / stdin / quit → `lifecycle` `scenario()`, file `.skip`

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| lifecycle/sigint-to-orch-during-mid-step.real.test.ts | exits via documented signal, tears down tmux, and leaves the terminal balanced | lifecycle/sigint--exits-cleanly-and-tears-down.test.ts | port | SIGINT shutdown invariants (exit/tmux-down/terminal-balanced/no-orphans), re-derived on the lifecycle driver (the strengthened U2 ctrl-c tracer). |
| lifecycle/sigint-to-orch-during-mid-step.real.test.ts | (the §9.8-ideal `persistedStatus('cancelled')` sub-claim) | — | drop | The old cell already omits it (documented finding); on `main` SIGINT does not persist `cancelled`. Asserting it would be false; source unchanged per U8 non-goal. `persistedStatus` itself stays covered by the lifecycle driver regression test against a planted state. |
| lifecycle/sigterm-to-orch-during-mid-step.real.test.ts | exits cleanly, tears down tmux, and leaves the terminal balanced | lifecycle/sigterm--exits-cleanly-and-tears-down.test.ts | port | SIGTERM shutdown invariants (KD2). |
| lifecycle/sighup-to-orch-during-mid-step.real.test.ts | exits cleanly, tears down tmux, and leaves the terminal balanced | lifecycle/sighup--exits-cleanly-and-tears-down.test.ts | port | SIGHUP (controlling-TTY hangup) shutdown invariants (KD2). |
| lifecycle/double-sigint-to-orch-during-mid-step.real.test.ts | still reaches the §6.5 signal-sigint clean state after a redundant SIGINT | lifecycle/double-sigint--still-reaches-clean-shutdown.test.ts | port | Redundant-second-SIGINT regression guard; same clean shutdown state (KD2). |
| lifecycle/close-stdin-during-mid-step.real.test.ts | preserves the weak close-stdin contract — terminal stays balanced | lifecycle/close-stdin--terminal-stays-balanced.test.ts | port | The WEAK contract mirrored exactly: settle, then assert only terminal balance — no exit/teardown matcher (orch v1 has no stdin-EOF handler). |
| lifecycle/q-during-fake-mid-step.real.test.ts | tears orch down cleanly — §6.5 pane-q-during-run | lifecycle/q-intent--tears-down-cleanly.test.ts | port | A daemon `quit` intent (via `tui-intents.ndjson`) tears orch down cleanly (exit + tmux gone). |

### G2 — click-to-focus → `lifecycle` `scenario()`, file `.skip`

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| lifecycle/click-to-focus-across-divider-smoke.real.test.ts | clicks move focus between the left and right panes | lifecycle/click-to-focus--moves-focus-across-divider.test.ts | port | Click-to-focus round-trip (right then back to left) via the W1 `click`/`assertFocused` affordances over real tmux — the mouse-event builder + focus matcher. |

### G3 — failure RENDERING → `model` (+ `screen` twin)

> **Reality correction (KD3, applied at implementation time).** The phase plan's
> premise that the two `failure.*` "x-glyph-and-error-banner" /
> "right-pane-failure-summary" lifecycle files assert *pane content* is
> contradicted by the code: both assert durable *on-disk* signals (lifecycle.ndjson
> / persisted state / per-step tee file) because at Tier 5 the pane is torn down
> sub-100ms when the workflow throws (the old files' own comments say the on-pane
> equivalent lives in the in-process tiers). By the decision rule + triage ("passes
> if the pane is empty?" → **yes**), all four `failure.*` files are persistence
> tests and relocate to **G4** (`side-effects/`), not `model`/`screen`. The genuine
> *rendering* gap U8 owns is the **failed-step glyph + colour**, which the U5a
> ledger explicitly deferred from `steps-view-colors.test.tsx` to U8. W4 closes
> exactly that, re-derived via the existing `outcome:'failed'` DSL (no lifecycle
> pane-reads). The error-BANNER rendering was already covered by the U5b
> `banner--info-and-error-paint` model/screen twins.

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| steps-view/steps-view-colors.test.tsx | renders a red cross for failed steps (the U5a-deferred "red-cross" case, assigned to U8) | model/failure--failed-step-glyph-and-color.test.ts (+ screen/failure--failed-step-glyph-and-color-bytes.test.ts) | port | Failed step row renders ✗ in red — projector decision (model) + bytes survive real tmux (screen), overlapGroup `failure-glyph`. **File stays LIVE** — its remaining per-status render cases (dim-pending / cyan-selection / preview-chevron / interactive / cached / stripAnsi-structure) are still deferred to U10–U13 (U5a ledger). |

### G4 — side effects / persistence → `tests-new/lifecycle/side-effects/` (non-`scenario()`), file `.skip`

> **Non-`scenario()` category** (KD1/KD4, the `tmux-argv` / `model/controller`
> precedent — see `tests-new/lifecycle/side-effects/README.md`). These drive a real
> orch subprocess and assert git / filesystem / persisted-state SIDE EFFECTS with
> zero pane assertions (triage = passes if the pane is empty), at one fidelity with
> no twin. They are plain `it()` tests importing behavioral-dsl from `@orch/test/*`
> (import-path parity, parent R10 — verified to import the same helper symbols as
> their baseline originals), NOT a shared-DSL extension. Includes the four
> `failure.*` files, which assert DISK signals despite two of their names mentioning
> the pane (KD3 reality correction above).

| Old file | Old case | New file (path) | Disposition | Reason |
|---|---|---|---|---|
| lifecycle/failure.persisted-state-reflects-failed-status.behavioral.real.test.ts | state.json status=failed, prior steps completed, failed step recorded | side-effects/failure-persisted-state.test.ts | port | Persisted-state side effect; passes with an empty pane. |
| lifecycle/failure.api-error-on-first-turn-keeps-run-failed-not-crashed.behavioral.real.test.ts | CLI emits terminal error + non-zero exit → step.failed, run.failed (NOT crashed) | side-effects/failure-api-error-is-failed-not-crashed.test.ts | port | Graceful-failure persistence. KD5: asserted as observed on `main` (`failed`); the old comment's RED prediction is stale (source since fixed). Source unchanged by U8. |
| lifecycle/failure.failed-step-shows-x-glyph-and-error-banner.behavioral.real.test.ts | puppet fail() emits step:failed in lifecycle.ndjson with the message and ends the run as failed | side-effects/failure-step-failed-recorded-on-disk.test.ts | port | The cell asserts DISK signals (lifecycle.ndjson + persisted state), not pane content — persistence, not rendering (KD3). The named ✗ glyph render → model/screen `failure-glyph` twin; the error banner → U5b banner twins. |
| lifecycle/failure.right-pane-shows-failure-summary.behavioral.real.test.ts | the per-step tee file contains the failure headline and error text | side-effects/failure-summary-written-to-tee.test.ts | port | The cell asserts a DISK side effect (the per-step tee file), not pane content (KD3). |
| lifecycle/commit.step-creates-real-commit-on-branch.behavioral.real.test.ts | git log on the worktree branch shows the commit added by the commit step | side-effects/commit-step-creates-real-commit.test.ts | port | Git side effect (`commitExists`). |
| lifecycle/worktree.creates-real-git-worktree-and-switches-cwd.behavioral.real.test.ts | git worktree list reports the branch and the agent step lands inside it | side-effects/worktree-creates-and-switches-cwd.test.ts | port | Git + fs side effect (`worktreeExists` + file under the worktree path). |
| lifecycle/worktree.post-create-shell-command-creates-file.behavioral.real.test.ts | postCreate ["touch sentinel.txt"] creates the file inside the worktree | side-effects/worktree-post-create-shell-command.test.ts | port | Fs side effect (`fileExistsAt` for the postCreate sentinel). |
| lifecycle/ask.noninteractive-uses-default-and-does-not-block.behavioral.real.test.ts | --noninteractive resolves the ask to its declared default and the next step runs | side-effects/ask-noninteractive-uses-default.test.ts | port | Non-blocking behaviour; persisted state shows both steps completed. |

### W6 — lifecycle-dir close-out: the 4 U5b/U6 rendering strays → file `.skip` (COVERED BY)

> These four files physically live in `tests/integration/lifecycle/` but belong to
> U5/U6's areas (the parent U5 old-sources list names `lifecycle/banner.*` and
> `lifecycle/end-of-run.*`). U5b/U6 built the model/screen/full-host replacements
> but never `.skip`ped these lifecycle copies. Each asserts a DISK signal as a
> teardown-race workaround for an unobservable pane; the rendering they are named
> for is covered by an existing twin (verified before close-out), so each is
> `demote`/`drop` + `// COVERED BY →`. No new twin was needed (no genuine gap).

| Old file | Old case | Covered by (path) | Disposition | Reason |
|---|---|---|---|---|
| lifecycle/banner.info-banner-auto-clears-after-ttl.behavioral.real.test.ts | the "step complete" info banner is visible briefly then disappears | model/banner--info-clears-error-persists.test.ts | demote→model | Info-banner TTL auto-clear is a render decision over time, proven on the virtual clock (D-P2). |
| lifecycle/banner.error-banner-persists-until-escape.behavioral.real.test.ts | error banner stays visible past the info-TTL and dismisses on Esc (`it.todo`) | model/banner--info-clears-error-persists.test.ts | drop | Never-executed `it.todo` placeholder (blocked at Tier 5). Persist-past-TTL covered at the model seam; the Esc-dismiss half never ran. File `describe.skip`. |
| lifecycle/end-of-run.right-pane-rests-on-final-step.behavioral.real.test.ts | the final step has a non-empty events.ndjson and session.json on disk | full-host/fake-agent/multi-step--right-pane-auto-advances.test.ts | demote | Visible right-pane rest-on-latest covered by the U6 full-host scenario; the disk-artifact half is subsumed by the still-LIVE per-step-artifacts cell (→U10–U13). |
| lifecycle/end-of-run.summary-and-completion-count-visible.behavioral.real.test.ts | all 3 steps complete, run status=completed, lifecycle.ndjson records run-ended | model/end-of-run--summary-and-count.test.ts (+ screen twin) | demote→model/screen | Visible summary + completion count covered by the U5b twins; the persisted-completed / run-ended disk assertion was a teardown-race workaround for the unobservable pane. |

### U8 lifecycle-dir drain (DoD)

> After U8 the **only** LIVE (non-`.skip`) files in `tests/integration/lifecycle/`
> are the three U6-deferred → U10–U13 relocations (reconcile rule 3 forbids a
> `MIGRATED →` marker to a not-yet-existing target):
> `command.output-streams-to-right-pane-and-exit-code-recorded`,
> `progression.per-step-artifacts-land-on-disk`,
> `resume.cached-steps-replay-with-cached-glyph`. Everything else U8 touched is
> `.skip` with a `// MIGRATED →` / `// COVERED BY →` marker and a case-granular row
> above.

## Migrated cases — `tier-4` / real-CLI (parent U9)

> **Phase 9 / U9** closes the two-pane real-CLI surface — the last of group B.
> The three `tests/e2e/tier-4/*` files (one frozen-baseline case each, D12) are
> re-derived through the `full-host:real-agent` driver (gated smokes) and flipped
> from capability-gating (`describe.skipIf(!canRun)`) to **unconditional**
> `describe.skip` (D2) so U14's reconcile reads them as migrated, not merely
> capability-skipped (R5). The interactive/autoStop passthrough (W1) made the
> auto-stop case expressible. `mixed-with-interactive` is a `drop`: a never-run
> `it.skip` placeholder asserting nothing, blocked on interactive-PTY-step harness
> support that still does not exist (deferred follow-up, parent §7 Scope).

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| tests/e2e/tier-4/autonomous-multi-step.real.e2e.test.ts | two real-CLI autonomous steps run to completion and right.capture() shows live transcript text | full-host/real-agent/autonomous-multi-step.test.ts | port | Re-derived as a two-pane pane-integration smoke: two real Claude steps complete and the second step's transcript paints in the right pane (§9.7). Gated; auto-skips off the gate. |
| tests/e2e/tier-4/auto-stop.real.e2e.test.ts | finishes its turn and the pane closes on its own with no keystroke | full-host/real-agent/auto-stop.test.ts | port | The unique AE2 proof: a real interactive turn auto-stops and paints its reply with NO keystroke — the real Stop-hook + real env + real tmux `wait-for` transport the fake cannot exercise. Unblocked by the W1 mode/autoStop passthrough. Gated. |
| tests/e2e/tier-4/mixed-with-interactive.real.e2e.test.ts | autonomous step + interactive step share the same harness body | — | drop | Never-executed `it.skip` placeholder that asserted nothing; depends on interactive-PTY-step harness support that does not exist. Re-derive when that helper lands (deferred follow-up). File `describe.skip` with `// DROPPED →`. |

## Born-new (no baseline twin) — parent U9 recorded realism

> Event-stream-*shape* realism the inline `emits(...)` fake cannot produce
> (multi-`tool_use` interleave; an error terminal). Hand-authored cassettes that
> replay deterministically through the fake-agent engine on the real two-pane host
> — no CLI, no network (parent §9.6, D9). Born in `tests-new/`, no old twin.

| Old file | Old case | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| — | — | full-host/recorded-agent/multi-tool-use.test.ts | new | born in tests-new/ (parent U9/W3); no old twin — a turn firing several `tool_use` events before its assistant line, a stream shape the inline fake cannot reproduce |
| — | — | full-host/recorded-agent/error-terminal.test.ts | new | born in tests-new/ (parent U9/W3); no old twin — a turn ending on `terminal.type: 'error'`; proves the failure outcome paints (not a hang/crash) |

## Relocated — `core/**` (parent U10)

> **Phase 10 / U10 is a RELOCATION, not a re-derivation (parent D1).** The
> `core/**` tests are already plain class/integration tests with fakes at the
> `*Service` seam — today's `unit` concept *is* the parent's `unit` category.
> Each file below was COPIED to its `tests-new/{unit,integration}/core` mirror
> with its body **byte-identical**; the only edit is the cross-tree helper
> specifier (`../../helpers/{fake-host,temp-git-repo,type-assertions}.ts` →
> `@orch/test/*`, parent D13). Every relocated file imports the **same `src/`**
> **symbols** as its baseline original, machine-verified per file by the new
> `import-parity` guard (`bun run check:import-parity`, parent R10) — so the
> 1:1 case identity D15 requires is preserved by construction, and one `port`
> row per file (the U7a/U7b relocation precedent, PD5) is the accounting. No
> case was split, merged, demoted, or dropped; no `src/` file was touched. The
> old copies are wrapped unconditional `describe.skip` with a `// MIGRATED →`
> marker and kept on disk forever (D2); the two real-CLI files
> (`commit-real`, `worktree-real`) had their OLD copy flipped from
> `describe.skipIf(!canRun)` to unconditional `describe.skip` so U14's reconcile
> reads them as MIGRATED, while the NEW copies keep `skipIf` (legitimate
> capability gating, D8). The 6 core `.test-d.ts` type-tests are **not** in this
> phase — deferred to U13 (PD1); the `_worktree-test-helpers.ts` asset relocated
> with the cluster (its old copy kept so the skipped old tests still resolve).

| Old file | Old case | New file (path) | Disposition | Reason |
|---|---|---|---|---|
| unit/core/ask.test.ts | (all 26 cases) | tests-new/unit/core/ask.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/command.test.ts | (all 38 cases) | tests-new/unit/core/command.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/commit.test.ts | (all 13 cases) | tests-new/unit/core/commit.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/derive-step-key.test.ts | (all 8 cases) | tests-new/unit/core/derive-step-key.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/errors.test.ts | (all 12 cases) | tests-new/unit/core/errors.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/execution-context.test.ts | (all 18 cases) | tests-new/unit/core/execution-context.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/failure-summary.test.ts | (all 8 cases) | tests-new/unit/core/failure-summary.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/interactive-mode.test.ts | (all 11 cases) | tests-new/unit/core/interactive-mode.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-04-13-009248-w8, r-2026-04-13-320115-3u, r-2026-04-13-585828-kn preserved. |
| unit/core/parallel-inherits-subworkflow-fields.test.ts | (all 7 cases) | tests-new/unit/core/parallel-inherits-subworkflow-fields.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/parallel.test.ts | (all 26 cases) | tests-new/unit/core/parallel.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/resume-registry.test.ts | (all 6 cases) | tests-new/unit/core/resume-registry.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/run-mode-tty-guard.test.ts | (all 3 cases) | tests-new/unit/core/run-mode-tty-guard.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/run-mode.test.ts | (all 17 cases) | tests-new/unit/core/run-mode.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/run-step-once-collision.test.ts | (all 6 cases) | tests-new/unit/core/run-step-once-collision.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-05-28-100001-aa preserved. |
| unit/core/run-workflow.test.ts | (all 12 cases) | tests-new/unit/core/run-workflow.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-05-28-110000-aa, r-2026-05-28-110000-ab, r-2026-05-28-110000-ac, r-2026-05-28-110000-en preserved. |
| unit/core/runner-addressing.test.ts | (all 6 cases) | tests-new/unit/core/runner-addressing.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-06-01-090000-aa preserved. |
| unit/core/schema-validation.test.ts | (all 11 cases) | tests-new/unit/core/schema-validation.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-04-12-408036-se, r-2026-04-12-935632-9n preserved. |
| unit/core/schema.test.ts | (all 20 cases) | tests-new/unit/core/schema.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/session-id-capture.test.ts | (all 4 cases) | tests-new/unit/core/session-id-capture.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-05-05-200000-zz preserved. |
| unit/core/step-lifecycle.test.ts | (all 6 cases) | tests-new/unit/core/step-lifecycle.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/step.test.ts | (all 34 cases) | tests-new/unit/core/step.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/types-step-name-pattern.test.ts | (all 11 cases) | tests-new/unit/core/types-step-name-pattern.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/types.test.ts | (all 11 cases) | tests-new/unit/core/types.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/view-registry.test.ts | (all 8 cases) | tests-new/unit/core/view-registry.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/workflow-args.test.ts | (all 6 cases) | tests-new/unit/core/workflow-args.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-04-14-031568-o6 preserved. |
| unit/core/workflow-auto-stop.test.ts | (all 7 cases) | tests-new/unit/core/workflow-auto-stop.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-05-25-000000-aa preserved. |
| unit/core/workflow-name-validation.test.ts | (all 12 cases) | tests-new/unit/core/workflow-name-validation.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/workflow-parallel-lifecycle.test.ts | (all 4 cases) | tests-new/unit/core/workflow-parallel-lifecycle.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/workflow-resume-registry.test.ts | (all 6 cases) | tests-new/unit/core/workflow-resume-registry.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-05-13-300000-zz preserved. |
| unit/core/workflow-tmux-guards.test.ts | (all 2 cases) | tests-new/unit/core/workflow-tmux-guards.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-04-14-097860-gx preserved. |
| unit/core/workflow-validators.test.ts | (all 10 cases) | tests-new/unit/core/workflow-validators.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-04-10-458000-q8 preserved. |
| unit/core/workflow-vars-cache-key.test.ts | (all 11 cases) | tests-new/unit/core/workflow-vars-cache-key.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-05-28-100000-aa preserved. |
| unit/core/workflow.test.ts | (all 26 cases) | tests-new/unit/core/workflow.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-04-10-458000-q8, r-2026-04-13-458000-q8 preserved. |
| unit/core/worktree-executor-cache.test.ts | (all 4 cases) | tests-new/unit/core/worktree-executor-cache.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/worktree-executor-conflicts.test.ts | (all 6 cases) | tests-new/unit/core/worktree-executor-conflicts.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/worktree-executor-postcreate.test.ts | (all 7 cases) | tests-new/unit/core/worktree-executor-postcreate.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/worktree-executor.test.ts | (all 8 cases) | tests-new/unit/core/worktree-executor.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/worktree.test.ts | (all 34 cases) | tests-new/unit/core/worktree.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/prompt-file/cache-key.test.ts | (all 18 cases) | tests-new/unit/core/prompt-file/cache-key.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/prompt-file/caller-dir.test.ts | (all 9 cases) | tests-new/unit/core/prompt-file/caller-dir.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/prompt-file/load-prompt.test.ts | (all 9 cases) | tests-new/unit/core/prompt-file/load-prompt.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/prompt-file/resolve-prompt-path.test.ts | (all 11 cases) | tests-new/unit/core/prompt-file/resolve-prompt-path.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/prompt-file/step-define-prompt-file.test.ts | (all 12 cases) | tests-new/unit/core/prompt-file/step-define-prompt-file.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| unit/core/prompt-file/substitute.test.ts | (all 26 cases) | tests-new/unit/core/prompt-file/substitute.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| integration/core/ask-lifecycle.test.ts | (all 2 cases) | tests-new/integration/core/ask-lifecycle.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-05-22-212450-a1 preserved. |
| integration/core/ask-mocked.test.ts | (all 11 cases) | tests-new/integration/core/ask-mocked.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-05-01-100000-a1, r-2026-05-01-100100-a2, r-2026-05-01-100200-a3, r-2026-05-01-100300-a4, r-2026-05-01-100400-a5, r-2026-05-01-100500-a6, r-2026-05-01-100700-a8 preserved. |
| integration/core/codex-thread-id-capture.integration.test.ts | (all 7 cases) | tests-new/integration/core/codex-thread-id-capture.integration.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-05-13-100001-cd, r-2026-05-13-100002-cd, r-2026-05-13-100003-cd, r-2026-05-13-100004-cd, r-2026-05-13-100005-cd, r-2026-05-13-100006-cd, r-2026-05-13-100007-cd preserved. |
| integration/core/command-mocked.test.ts | (all 21 cases) | tests-new/integration/core/command-mocked.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-05-05-100000-c1, r-2026-05-05-100200-c2 preserved. |
| integration/core/command-real.test.ts | (all 8 cases) | tests-new/integration/core/command-real.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-05-05-100000-rl preserved. |
| integration/core/commit-mocked.test.ts | (all 3 cases) | tests-new/integration/core/commit-mocked.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-04-13-398232-yj, r-2026-04-13-458000-q8 preserved. |
| integration/core/commit-real.test.ts | (all 3 cases) | tests-new/integration/core/commit-real.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-04-13-416112-w6, r-2026-04-13-638488-e2 preserved. |
| integration/core/interactive-workflow.test.ts | (all 2 cases) | tests-new/integration/core/interactive-workflow.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-04-14-414240-6m, r-2026-04-14-636616-oi preserved. |
| integration/core/parallel-mocked.test.ts | (all 5 cases) | tests-new/integration/core/parallel-mocked.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-04-12-200640-3c, r-2026-04-12-423020-l8, r-2026-04-12-533496-jo, r-2026-04-12-755876-2k, r-2026-04-12-978256-kg preserved. |
| integration/core/prompt-file-workflow.test.ts | (all 5 cases) | tests-new/integration/core/prompt-file-workflow.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). |
| integration/core/resume.test.ts | (all 9 cases) | tests-new/integration/core/resume.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-04-13-002761-5n, r-2026-04-13-113237-33, r-2026-04-13-225142-nj, r-2026-04-13-335618-lz, r-2026-04-13-447523-5f, r-2026-04-13-557999-4v, r-2026-04-13-668475-2b, r-2026-04-13-780380-mr, r-2026-04-13-890856-k7 preserved. |
| integration/core/typed-vars-workflow.test.ts | (all 5 cases) | tests-new/integration/core/typed-vars-workflow.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-05-28-100000-aa preserved. |
| integration/core/validators-workflow.test.ts | (all 3 cases) | tests-new/integration/core/validators-workflow.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-04-11-889356-fn preserved. |
| integration/core/view-resolution.test.ts | (all 3 cases) | tests-new/integration/core/view-resolution.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-04-23-419108-97 preserved. |
| integration/core/workflow.test.ts | (all 3 cases) | tests-new/integration/core/workflow.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-04-10-458000-q8 preserved. |
| integration/core/worktree-mocked.test.ts | (all 4 cases) | tests-new/integration/core/worktree-mocked.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-04-30-100000-w1, r-2026-04-30-100100-w2, r-2026-04-30-100200-w3 preserved. |
| integration/core/worktree-real.test.ts | (all 6 cases) | tests-new/integration/core/worktree-real.test.ts | port | Verbatim relocation — body byte-identical; only the cross-tree helper specifier rewritten to `@orch/test/*` (src import set unchanged, parity guard green). Regression pins r-2026-04-30-200000-w1 preserved. |

### Infra moves (D13) — not test rows

> These two shared helpers were **moved** to `tests-new/_support/` (U10.2), with a
> thin re-export shim left at the old `tests/helpers/` path so still-live non-core
> consumers keep resolving until they relocate in U11–U13 (R11). They are baseline
> `helper`/`asset` entries, **not** `test` entries — U14 reconcile accounts for
> them via this D13 `_support` move, not as relocated tests. Both keep their own
> `../../src/...` imports valid (two dirs deep before and after the move).

| Helper | From | To | Shim left at |
|---|---|---|---|
| fake-host.ts | tests/helpers/fake-host.ts | tests-new/_support/fake-host.ts | tests/helpers/fake-host.ts (`export * from '@orch/test/...'`) |
| temp-git-repo.ts | tests/helpers/temp-git-repo.ts | tests-new/_support/temp-git-repo.ts | tests/helpers/temp-git-repo.ts (`export * from '@orch/test/...'`) |
