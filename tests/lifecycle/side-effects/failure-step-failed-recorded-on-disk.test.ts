/**
 * Relocated (parent U8 / G4) from
 * `tests/integration/lifecycle/failure.failed-step-shows-x-glyph-and-error-banner.behavioral.real.test.ts`.
 *
 * Despite its old NAME, this cell asserts the durable on-disk failure signals,
 * not pane content: the workflow lifecycle log records `step:failed` for the
 * failed step with the error message, and the persisted run status flips to
 * `failed` with prior steps `completed`. (At Tier 5 the pane is torn down
 * sub-100ms when the workflow throws, so the visible ✗ glyph / error banner are
 * covered by the rendering tiers — now the `model`/`screen` `failure-glyph` twin
 * and the U5b banner twins.) Relocation parity: same assertions, new path.
 */

import { describe, it } from 'bun:test'
import * as nodePath from 'node:path'
import {
  assertFilesystem,
  assertPersistedState,
  awaitRunStatus,
  awaitStepStatus,
  awaitVisibleStep,
  fileContains,
  hasRunStatus,
  hasStepCompleted,
  hasStepFailed,
  puppet,
  withinMs,
} from '@orch/test/behavioral-dsl/index.ts'
import { tmuxAvailable, withOrchHandle } from './_support.ts'

describe.skipIf(!tmuxAvailable)('side-effects — failed step is recorded on disk', () => {
  it('puppet fail() emits step:failed in lifecycle.ndjson with the message and ends the run as failed', async () => {
    const handle = await withOrchHandle('puppet-can-fail', {
      script: { plan: puppet(), execute: puppet() },
    })

    await awaitVisibleStep('left', 'plan', { timeoutMs: 10_000 })
    await handle.agent('plan').complete()
    await awaitStepStatus('plan', 'completed', { timeoutMs: 5_000 })

    await awaitVisibleStep('left', 'execute', { timeoutMs: 10_000 })
    await handle.agent('execute').fail({ message: 'boom-d16' })

    await awaitStepStatus('execute', 'failed', { timeoutMs: 10_000 })
    await awaitRunStatus('failed', { timeoutMs: 10_000 })

    const lifecycleLog = nodePath.join(handle.stateDir, 'logs', 'lifecycle.ndjson')
    await assertFilesystem(
      withinMs(5_000),
      fileContains(lifecycleLog, '"type":"step:failed"'),
      fileContains(lifecycleLog, '"stepName":"execute"'),
      fileContains(lifecycleLog, 'boom-d16'),
    )

    await assertPersistedState(
      withinMs(5_000),
      hasRunStatus('failed'),
      hasStepCompleted('plan'),
      hasStepFailed('execute'),
    )
  }, 45_000)
})
