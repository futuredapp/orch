/**
 * Behavioral cell — per-step artifacts (session.json, events.ndjson) land on
 * disk under `.orch/state/<runId>/agents/<step>/` after each step completes.
 */

import { afterEach, beforeEach, describe, it } from 'bun:test'
import {
  assertFilesystem,
  awaitStepStatus,
  awaitVisibleStep,
  launchOrchWorkflow,
  type OrchHandle,
  puppet,
  runArtifactExists,
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

describe.skipIf(!canRunRealTmux())('Tier 5 behavioral — per-step artifacts', () => {
  it('writes session.json and events.ndjson for each completed step', async () => {
    handle = await launchOrchWorkflow('three-step-linear', {
      script: { plan: puppet(), execute: puppet(), finalize: puppet() },
    })

    await awaitVisibleStep('left', 'plan', { timeoutMs: 10_000 })
    await handle
      .agent('plan')
      .emit({ kind: 'info', type: 'thinking', payload: { text: 'planning' } })
    await handle.agent('plan').complete()
    await awaitStepStatus('plan', 'completed', { timeoutMs: 5_000 })

    await assertFilesystem(
      withinMs(5_000),
      runArtifactExists('session', 'plan'),
      runArtifactExists('events', 'plan'),
    )
  }, 30_000)
})
