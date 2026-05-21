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

describe.skipIf(!canRunRealTmux())(
  'Tier 5 behavioral — first step running + right pane live',
  () => {
    it('shows the running glyph on the first step and the live source in the right pane', async () => {
      handle = await launchOrchWorkflow('single-agent-step', {
        script: { work: puppet() },
      })

      await awaitVisibleStep('left', 'work', { timeoutMs: 10_000 })

      await assertLeftPane(withinMs(5_000), showsStep('work', 'running'))
      await assertRightPane(withinMs(5_000), containsText('work'))
    }, 30_000)
  },
)
