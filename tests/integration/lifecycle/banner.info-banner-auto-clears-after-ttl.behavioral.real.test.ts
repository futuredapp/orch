/**
 * Behavioral cell — an info banner disappears after its TTL (4000ms default
 * in src/hosts/two-pane/steps-view/steps-view.tsx:154). The cell asserts
 * the banner is visible shortly after emit and is gone after the TTL.
 *
 * Trigger chain: completing `plan` flips the controller into replay mode +
 * emits `step plan complete` (right-pane-controller.ts:408). When `execute`
 * then starts, its registerSource path (still replay mode) emits the
 * `step execute running — press f to follow` info banner — that is the
 * banner we assert against, since the prior one was overwritten by the
 * second emit within ~ms (last-write-wins).
 */

import { afterEach, beforeEach, describe, it } from 'bun:test'
import {
  assertLeftPane,
  awaitVisibleStep,
  doesNotContain,
  launchOrchWorkflow,
  type OrchHandle,
  puppet,
  showsInfoBanner,
  userAction,
  wait,
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

describe.skipIf(!canRunRealTmux())('Tier 5 behavioral — info banner auto-clears after TTL', () => {
  it('the "press f to follow" info banner is visible briefly then disappears', async () => {
    handle = await launchOrchWorkflow('three-step-linear', {
      script: { plan: puppet(), execute: puppet(), finalize: puppet() },
    })

    await awaitVisibleStep('left', 'plan', { timeoutMs: 10_000 })

    // Completing plan flips view to replay + emits the first info banner;
    // execute then starts and emits the durable replay-mode info banner.
    await handle.agent('plan').complete()

    await assertLeftPane(withinMs(5_000), showsInfoBanner('press f to follow'))

    // Wait past the 4000ms TTL; the banner should be gone. We do not
    // complete `execute` so no follow-up emit replaces the banner.
    await userAction(wait(4_500))

    await assertLeftPane(withinMs(2_000), doesNotContain('press f to follow'))
  }, 30_000)
})
