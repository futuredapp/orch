/**
 * Behavioral cell — after step 1 completes, the live focus moves to step 2
 * (which becomes running). Asserts both step rows reach the expected glyphs;
 * pane selection follow-up is verified separately in `nav.*` cells.
 */

import { afterEach, beforeEach, describe, it } from 'bun:test'
import {
  assertLeftPane,
  awaitVisibleStep,
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

describe.skipIf(!canRunRealTmux())('Tier 5 behavioral — live focus follows next step', () => {
  it('next step becomes running after the prior one completes', async () => {
    handle = await launchOrchWorkflow('three-step-linear', {
      script: { plan: puppet(), execute: puppet(), finalize: puppet() },
    })

    await awaitVisibleStep('left', 'plan', { timeoutMs: 10_000 })
    await handle.agent('plan').complete()

    await assertLeftPane(
      withinMs(10_000),
      showsStep('plan', 'completed'),
      showsStep('execute', 'running'),
    )
  }, 30_000)
})
