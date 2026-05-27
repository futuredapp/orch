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
import { canRunRealTmux, REAL_TMUX_ASSERT_TIMEOUT_MS } from '../../helpers/real-tmux/fixture.ts'

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

    await awaitVisibleStep('left', 'plan', { timeoutMs: REAL_TMUX_ASSERT_TIMEOUT_MS })
    await assertLeftPane(withinMs(REAL_TMUX_ASSERT_TIMEOUT_MS), showsStep('plan', 'running'))

    await handle.agent('plan').complete()

    await assertLeftPane(withinMs(REAL_TMUX_ASSERT_TIMEOUT_MS), showsStep('plan', 'completed'))
    await assertPersistedState(withinMs(REAL_TMUX_ASSERT_TIMEOUT_MS), hasStepCompleted('plan'))
  }, 60_000)
})
