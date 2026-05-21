/**
 * Behavioral cell — from a viewing state on a completed step, pressing `f`
 * returns the footer to live mode (right pane swaps back to the live step).
 */

/**
 * BLOCKED ON PRODUCT BUG (see `docs/findings/2026-05-20-behavioral-batch-findings.md`):
 *
 * `followLive()` at `src/hosts/two-pane/pane-map/right-pane-controller.ts:422`
 * swaps the right pane back to the live source but does NOT call
 * `setViewMode({ mode: 'live' })`. As a result, after pressing `f` from a
 * viewing state, the right pane DOES update (correct), but the left-pane
 * footer remains stuck on `⏸ viewing <step>` (wrong). The footer's
 * `▶ live · …` indicator only re-renders when entering a running step
 * (`dispatchEnter` line 506) or being auto-driven by a step:start event —
 * `f` is not wired to refresh the view mode.
 *
 * Manual repro: launch `behavioral-three-step-linear`, wait for the second
 * step to start, press Enter on the first completed step, observe footer
 * flips to `⏸ viewing plan`, press `f`, observe footer stays.
 *
 * Restoring this cell requires either patching `followLive()` to flip view
 * mode, or refining the cell's contract to assert only the right-pane swap.
 */

import { describe, it } from 'bun:test'
import { canRunRealTmux } from '../../helpers/real-tmux/fixture.ts'

describe.skipIf(!canRunRealTmux())('Tier 5 behavioral — f snaps to live', () => {
  it.todo('pressing f after entering a viewing state returns the footer to live mode (BLOCKED: product bug — followLive does not call setViewMode)', async () => {
    /* see findings doc P-1 */
  })
})
