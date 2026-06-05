/**
 * Behavioral cell — `?` opens the help overlay; `Esc` closes it. The underlying
 * step list remains intact after the toggle cycle.
 */

import { afterEach, beforeEach, describe, it } from 'bun:test'
import {
  assertLeftPane,
  awaitVisibleStep,
  closeHelp,
  doesNotContain,
  launchOrchWorkflow,
  type OrchHandle,
  openHelp,
  puppet,
  showsHelpOverlay,
  showsStep,
  userAction,
  withinMs,
} from '../../helpers/behavioral-dsl/index.ts'
import { canRunRealTmux, REAL_TMUX_ASSERT_TIMEOUT_MS } from '../../helpers/real-tmux/fixture.ts'

let handle: OrchHandle | undefined

beforeEach(() => {
  handle = undefined
})

afterEach(async () => {
  if (handle !== undefined) await handle.teardown()
})

// MIGRATED → tests-new/model/help-overlay--opens-and-closes.test.ts
//            (+ tests-new/screen/help-overlay--paint-bytes.test.ts) — parent U6a.2.
// port: ? opens the keymap overlay, Esc closes it, the step list survives.
describe.skipIf(!canRunRealTmux())('Tier 5 behavioral — help overlay toggle', () => {
  it.skip('? opens help overlay, Esc closes it, and the step list survives', async () => {
    handle = await launchOrchWorkflow('three-step-linear', {
      script: { plan: puppet(), execute: puppet(), finalize: puppet() },
    })

    await awaitVisibleStep('left', 'plan', { timeoutMs: REAL_TMUX_ASSERT_TIMEOUT_MS })

    await userAction(openHelp())
    await assertLeftPane(withinMs(REAL_TMUX_ASSERT_TIMEOUT_MS), showsHelpOverlay())

    await userAction(closeHelp())
    await assertLeftPane(
      withinMs(REAL_TMUX_ASSERT_TIMEOUT_MS),
      showsStep('plan'),
      // The viewing footer should not be present after closing help.
      doesNotContain('viewing plan'),
    )
    // 60s `it.skip()` ceiling (matches the other behavioral.real cells): leaves
    // room for the three sequential 15s polling assertions above to each play
    // out under contention so the *internal* budget — which names what it
    // waited for — is the binding constraint, not the generic `it.skip()` timeout.
  }, 60_000)
})
