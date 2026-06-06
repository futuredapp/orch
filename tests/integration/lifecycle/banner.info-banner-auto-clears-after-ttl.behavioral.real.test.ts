/**
 * Behavioral cell — an info banner disappears after its TTL (4000ms default
 * in src/hosts/two-pane/steps-view/steps-view.tsx:154). The cell asserts
 * the banner is visible shortly after emit and is gone after the TTL.
 *
 * Trigger chain: while the user is tracking the live edge, completing the
 * watched step emits a `step <name> complete` info banner (ttl 4000) — and
 * because follow stays engaged, the next step auto-advances WITHOUT emitting
 * its own banner, so the completion banner is the last write and persists
 * until its TTL. We complete `plan` (banner emitted, view auto-advances to
 * `execute`) and leave `execute` running so nothing overwrites the banner
 * before the TTL elapses.
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

// COVERED BY → tests-new/model/banner--info-clears-error-persists.test.ts — parent U8 (W6 close-out; U5b area).
// demote→model: info-banner TTL auto-clear is a render decision over time, proven
// deterministically on the virtual clock (D-P2) — never a real wall-clock wait.
describe.skipIf(!canRunRealTmux())('Tier 5 behavioral — info banner auto-clears after TTL', () => {
  it.skip('the "step complete" info banner is visible briefly then disappears', async () => {
    handle = await launchOrchWorkflow('three-step-linear', {
      script: { plan: puppet(), execute: puppet(), finalize: puppet() },
    })

    await awaitVisibleStep('left', 'plan', { timeoutMs: 10_000 })

    // Completing the watched step emits a `step plan complete` info banner;
    // follow stays engaged so execute auto-advances without its own banner,
    // leaving the completion banner as the durable last write.
    await handle.agent('plan').complete()

    await assertLeftPane(withinMs(5_000), showsInfoBanner('plan complete'))

    // Wait past the 4000ms TTL; the banner should be gone. We do not complete
    // `execute` so no follow-up emit replaces the banner.
    await userAction(wait(4_500))

    await assertLeftPane(withinMs(2_000), doesNotContain('plan complete'))
  }, 30_000)
})
