// triage: keep — Tier 1 interactive-pane prompt visibility.
//
// An interactive (PTY) step's first prompt sentinel must appear in the
// visible right pane within a bounded window. With a FakeRunner agent slot
// the buildCommand argv is `[':fake:', <nonce>]` — not a real executable —
// so the right-pane PTY spawn fails before any bytes reach the pane.
// Tier 4 (real CLI) is where this scenario gets its end-to-end coverage;
// Tier 2 covers the projection-layer "interactive view shows the prompt"
// assertion against a hand-rolled `StepsViewState`.
//
// Once the harness ships an "echo runner" (a Runner adapter that produces a
// real argv printing a prompt sentinel through a shell — deferred follow-
// up), this skip can be removed.

import { describe, it } from 'bun:test'
import { canRunRealTmux } from '../../../../helpers/real-tmux/index.ts'

const tmuxAvailable = canRunRealTmux()
const deferred = true

describe.skipIf(!tmuxAvailable || deferred)(
  'Tier 1 — interactive pane shows prompt (DEFERRED — needs real PTY-producing agent)',
  () => {
    it.skip('right.waitForText resolves on the prompt sentinel for an interactive step', () => {
      // Implementation deferred — see file header. Tier 4 covers the
      // visible-pane outcome with a real CLI agent.
    })
  },
)
