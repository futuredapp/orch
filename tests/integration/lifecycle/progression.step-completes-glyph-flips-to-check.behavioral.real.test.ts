/**
 * Behavioral cell — step row glyph transitions running → completed when the
 * puppet sends `complete()`, and `state.json` reflects `step: completed`.
 */

import { afterEach, beforeEach, describe, it } from 'bun:test'
import {
  assertLeftPane,
  assertPersistedState,
  awaitVisibleStep,
  hasStepCompleted,
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

describe.skipIf(!canRunRealTmux())('Tier 5 behavioral — step glyph flips on complete', () => {
  it('renders completed glyph and persists completed status after puppet completes', async () => {
    handle = await launchOrchWorkflow('three-step-linear', {
      script: { plan: puppet(), execute: puppet(), finalize: puppet() },
    })

    await awaitVisibleStep('left', 'plan', { timeoutMs: 10_000 })
    await assertLeftPane(withinMs(5_000), showsStep('plan', 'running'))

    await handle.agent('plan').complete()

    await assertLeftPane(withinMs(10_000), showsStep('plan', 'completed'))
    await assertPersistedState(withinMs(5_000), hasStepCompleted('plan'))
  }, 30_000)
})
