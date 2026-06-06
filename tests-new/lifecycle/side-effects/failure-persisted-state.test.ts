/**
 * Relocated (parent U8 / G4) from
 * `tests/integration/lifecycle/failure.persisted-state-reflects-failed-status.behavioral.real.test.ts`.
 *
 * Side effect: when a step fails, the persisted run state reaches `failed` (NOT
 * `crashed` — a clean step-level failure is not an executor crash), prior steps
 * stay `completed`, and the failed step is recorded `failed`. Relocation parity:
 * same assertions, new path; imports via the `@orch/test/*` alias.
 */

import { describe, it } from 'bun:test'
import {
  assertPersistedState,
  awaitRunStatus,
  awaitStepStatus,
  awaitVisibleStep,
  hasRunStatus,
  hasStepCompleted,
  hasStepFailed,
  puppet,
  withinMs,
} from '@orch/test/behavioral-dsl/index.ts'
import { tmuxAvailable, withOrchHandle } from './_support.ts'

describe.skipIf(!tmuxAvailable)('side-effects — persisted state reflects failed status', () => {
  it('state.json status=failed, prior steps completed, failed step recorded', async () => {
    const handle = await withOrchHandle('puppet-can-fail', {
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
})
