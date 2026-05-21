/**
 * Behavioral cell — ↑/↓ moves the left-pane selection, but the running step's
 * glyph remains intact (selection is decoupled from live focus).
 */

import { afterEach, beforeEach, describe, it } from 'bun:test'
import {
  assertLeftPane,
  awaitVisibleStep,
  launchOrchWorkflow,
  type OrchHandle,
  pressKeyInPane,
  puppet,
  showsStep,
  userAction,
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
  'Tier 5 behavioral — ↑/↓ navigation preserves live step glyph',
  () => {
    it('arrow keys move selection while the live step stays marked running', async () => {
      handle = await launchOrchWorkflow('three-step-linear', {
        script: { plan: puppet(), execute: puppet(), finalize: puppet() },
      })

      await awaitVisibleStep('left', 'plan', { timeoutMs: 10_000 })
      await assertLeftPane(withinMs(5_000), showsStep('plan', 'running'))

      await userAction(pressKeyInPane('left', 'Down'))
      await userAction(pressKeyInPane('left', 'Up'))

      // The live step is still running regardless of where the selection moved.
      await assertLeftPane(withinMs(2_000), showsStep('plan', 'running'))
    }, 30_000)
  },
)
