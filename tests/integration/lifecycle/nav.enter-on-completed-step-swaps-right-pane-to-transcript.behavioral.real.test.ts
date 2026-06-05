/**
 * Behavioral cell — pressing Enter on a completed step's row swaps the right
 * pane to that step's transcript and flips the footer to viewing mode.
 */

import { afterEach, beforeEach, describe, it } from 'bun:test'
import {
  assertLeftPane,
  assertRightPane,
  awaitStepStatus,
  awaitVisibleStep,
  containsText,
  launchOrchWorkflow,
  type OrchHandle,
  puppet,
  userAction,
  viewStep,
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

// MIGRATED → tests-new/full-host/fake-agent/nav--enter-swaps-right-pane-to-transcript.test.ts — parent U6a.3.
// port: Enter on a completed step swaps the visible right pane to its source.
describe.skipIf(!canRunRealTmux())(
  'Tier 5 behavioral — Enter swaps right pane to selected step',
  () => {
    it.skip('viewing a completed step shows its transcript and flips the footer', async () => {
      handle = await launchOrchWorkflow('three-step-linear', {
        script: { plan: puppet(), execute: puppet(), finalize: puppet() },
      })

      await awaitVisibleStep('left', 'plan', { timeoutMs: 10_000 })
      await handle
        .agent('plan')
        .emit({ kind: 'info', type: 'thinking', payload: { text: 'plan transcript marker' } })
      await handle.agent('plan').complete()
      await awaitStepStatus('plan', 'completed', { timeoutMs: 5_000 })

      await userAction(viewStep('plan'))

      // Footer flips to viewing mode; right pane shows the plan transcript.
      // 10s budget: dispatchEnter chains lookupStep → resolveReplaySpec →
      // registerSource (splitPane) → showSource → setViewMode, and a loaded
      // CI box has been observed exceeding the 5s original budget.
      await assertLeftPane(withinMs(10_000), containsText('viewing plan'))
      await assertRightPane(withinMs(10_000), containsText('plan transcript marker'))
    }, 30_000)
  },
)
