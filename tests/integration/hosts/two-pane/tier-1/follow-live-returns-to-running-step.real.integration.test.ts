// triage: keep — Tier 1 follow-live (`F`) intent coverage.
//
// The "follow-live" intent should swap the right pane back to the currently-
// running live source after the user navigated to a past step's replay.
// Deterministically observing this requires the run to be paused between two
// steps so one is completed and another is live at the same moment — a
// scenario the synchronous FakeRunner cannot produce without a pause hook
// on the workflow body. The harness's `runWorkflow` is fire-and-forget over
// a single FakeRunner script.
//
// **Why this test is currently a placeholder.** R9 names this scenario as
// Tier 1, but the deterministic version belongs in Tier 4 (real-CLI run
// where the agent takes real wall-clock time, leaving a window for the
// keypress) or in Tier 2 (projection layer: assert that the `follow-live`
// intent flips view mode and the projected source resolves to the live
// step). The follow-up captured in U8's docs notes this gap; the audit doc
// (U5) will reference this file when it lists the bug class as covered at
// Tier 2.
//
// Once the harness gains a "pause workflow between steps" hook (deferred
// follow-up — see plan §"Deferred to Follow-Up Work"), this skip can be
// removed and the deterministic assertion landed.

import { describe, it } from 'bun:test'
import { canRunRealTmux } from '../../../../helpers/real-tmux/index.ts'

const tmuxAvailable = canRunRealTmux()
const deferred = true

describe.skipIf(!tmuxAvailable || deferred)(
  'Tier 1 — follow-live returns to the running step (DEFERRED — needs paused-workflow hook)',
  () => {
    it.skip('press F after navigating to a past step swaps right pane back to the live source', () => {
      // Implementation deferred — see file header. Tier 2 projection test
      // covers the intent-flip path; Tier 4 covers the visible-pane outcome.
    })
  },
)
