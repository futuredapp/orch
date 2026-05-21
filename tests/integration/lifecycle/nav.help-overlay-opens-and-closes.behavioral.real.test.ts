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
import { canRunRealTmux } from '../../helpers/real-tmux/fixture.ts'

let handle: OrchHandle | undefined

beforeEach(() => {
  handle = undefined
})

afterEach(async () => {
  if (handle !== undefined) await handle.teardown()
})

describe.skipIf(!canRunRealTmux())('Tier 5 behavioral — help overlay toggle', () => {
  it('? opens help overlay, Esc closes it, and the step list survives', async () => {
    handle = await launchOrchWorkflow('three-step-linear', {
      script: { plan: puppet(), execute: puppet(), finalize: puppet() },
    })

    await awaitVisibleStep('left', 'plan', { timeoutMs: 10_000 })

    await userAction(openHelp())
    await assertLeftPane(withinMs(5_000), showsHelpOverlay())

    await userAction(closeHelp())
    await assertLeftPane(
      withinMs(5_000),
      showsStep('plan'),
      // The viewing footer should not be present after closing help.
      doesNotContain('viewing plan'),
    )
  }, 30_000)
})
