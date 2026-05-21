/**
 * Behavioral cell — when an agent step fails (puppet `fail({ message })`):
 *   - the workflow lifecycle log records `step:failed` for the failed step;
 *   - the per-step events.ndjson contains the runner's `terminal/error`
 *     event with the failure message;
 *   - the persisted run status flips to `failed` (NOT `crashed` — a clean
 *     step-level failure is not an executor crash; see workflow.ts:1235).
 *
 * Originally the cell asserted on the rendered ✗ glyph and the error banner
 * directly off the left pane. In two-pane `--no-attach` mode the host calls
 * `teardown()` in execute-with-attach.ts:174 the moment the workflow throws,
 * which tears down the tmux session in <100ms — well below the polling
 * cadence. The visible-pane assertion is therefore covered by Tier 1
 * (in-process host, FakeRunner) and Tier 2; here we assert the durable
 * on-disk signals that prove the failure path fired.
 */

import { afterEach, beforeEach, describe, it } from 'bun:test'
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

describe.skipIf(!canRunRealTmux())('Tier 5 behavioral — failed step is recorded', () => {
  it('puppet fail() emits step:failed in lifecycle.ndjson with the message and ends the run as failed', async () => {
    handle = await launchOrchWorkflow('puppet-can-fail', {
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
