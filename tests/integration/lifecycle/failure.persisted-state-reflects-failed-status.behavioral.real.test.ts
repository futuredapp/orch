/**
 * Behavioral cell — when a step fails, the persisted run state reaches
 * `failed` (NOT `crashed` — see workflow.ts:1235), prior steps remain
 * `completed`, and the failed step shows up as `failed` (lifecycle.ndjson-
 * derived in our snapshot since `saveStep` is skipped on throw).
 */

import { afterEach, beforeEach, describe, it } from 'bun:test'
import {
  assertPersistedState,
  awaitRunStatus,
  awaitStepStatus,
  awaitVisibleStep,
  hasRunStatus,
  hasStepCompleted,
  hasStepFailed,
  launchOrchWorkflow,
  type OrchHandle,
  puppet,
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

// MIGRATED → tests-new/lifecycle/side-effects/failure-persisted-state.test.ts — parent U8 (G4).
// port: persisted-state side effect (run failed, prior completed, step failed).
describe.skipIf(!canRunRealTmux())(
  'Tier 5 behavioral — persisted state reflects failed status',
  () => {
    it.skip('state.json status=failed, prior steps completed, failed step recorded', async () => {
      handle = await launchOrchWorkflow('puppet-can-fail', {
        script: { plan: puppet(), execute: puppet() },
      })

      await awaitVisibleStep('left', 'plan', { timeoutMs: 10_000 })
      await handle.agent('plan').complete()
      await awaitStepStatus('plan', 'completed', { timeoutMs: 5_000 })

      await awaitVisibleStep('left', 'execute', { timeoutMs: 10_000 })
      await handle.agent('execute').fail({ message: 'boom-d18-persist' })
      await awaitRunStatus('failed', { timeoutMs: 10_000 })

      await assertPersistedState(
        withinMs(5_000),
        hasRunStatus('failed'),
        hasStepCompleted('plan'),
        hasStepFailed('execute'),
      )
    }, 45_000)
  },
)
