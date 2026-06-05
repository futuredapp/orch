/**
 * Behavioral cell — first step shows running glyph and right pane reflects
 * its live source on launch.
 *
 * `stepIsHighlighted` is intentionally omitted from this cell because a
 * single-step workflow does not render a `↑↓` selection cursor (one row is
 * trivially "selected"). The multi-step variant in `three-step-linear`
 * exercises the highlight.
 */

import { afterEach, beforeEach, describe, it } from 'bun:test'
import {
  assertLeftPane,
  assertRightPane,
  awaitVisibleStep,
  containsText,
  launchOrchWorkflow,
  type OrchHandle,
  puppet,
  showsStep,
  withinMs,
} from '../../helpers/behavioral-dsl/index.ts'
import { canRunRealTmux } from '../../helpers/real-tmux/fixture.ts'

let handle: OrchHandle | undefined

beforeEach(() => {
  handle = undefined
})

afterEach(async () => {
  if (handle !== undefined) await handle.teardown()
})

// MIGRATED → split across tests-new/model/launch--first-step-running-and-highlighted.test.ts (glyph + highlight),
//            tests-new/screen/launch--first-step-running-and-highlighted.test.ts (glyph bytes),
//            tests-new/full-host/fake-agent/follow-live--right-pane-swaps-source.test.ts (live source in right pane),
//            tests-new/lifecycle/launch--boots-to-mid-step-and-tears-down.test.ts (boot) — parent U4.
// port: the one old case re-derives across categories by the decision rule (§6).
describe.skipIf(!canRunRealTmux())(
  'Tier 5 behavioral — first step running + right pane live',
  () => {
    it.skip('shows the running glyph on the first step and the live source in the right pane', async () => {
      handle = await launchOrchWorkflow('single-agent-step', {
        script: { work: puppet() },
      })

      await awaitVisibleStep('left', 'work', { timeoutMs: 10_000 })

      await assertLeftPane(withinMs(5_000), showsStep('work', 'running'))
      await assertRightPane(withinMs(5_000), containsText('work'))
    }, 30_000)
  },
)
