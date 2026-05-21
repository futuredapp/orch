/**
 * Behavioral cell — after a crashed run, `orch resume <id>` replays cached
 * steps from `state.json` (the runner is NOT invoked again) and re-runs the
 * step that failed. The resumed run completes; per-step artifacts for the
 * cached step are preserved from the first run.
 *
 * Pane-level "cached glyph" rendering is covered at Tier 1 (in-process
 * host). Here we assert the durable resume contract: the cached step's
 * persisted entry survives across runs; the failed step is re-executed and
 * persists fresh; and the second run reaches `completed`.
 */

import { afterEach, beforeEach, describe, it } from 'bun:test'
import {
  assertPersistedState,
  awaitRunStatus,
  awaitStepStatus,
  awaitVisibleStep,
  hasRunStatus,
  hasStepCompleted,
  launchOrchWorkflow,
  type OrchHandle,
  puppet,
  resumeOrchWorkflow,
  withinMs,
} from '../../helpers/behavioral-dsl/index.ts'
import { canRunRealTmux } from '../../helpers/real-tmux/fixture.ts'

let firstHandle: OrchHandle | undefined
let secondHandle: OrchHandle | undefined

beforeEach(() => {
  firstHandle = undefined
  secondHandle = undefined
})

afterEach(async () => {
  // Tear down the resumed handle first; it does not own the state base.
  if (secondHandle !== undefined) await secondHandle.teardown()
  if (firstHandle !== undefined) await firstHandle.teardown()
})

describe.skipIf(!canRunRealTmux())('Tier 5 behavioral — orch resume replays cached steps', () => {
  it('cached plan survives across runs; execute re-runs and the resumed run completes', async () => {
    firstHandle = await launchOrchWorkflow('resumable-crash', {
      script: { plan: puppet(), execute: puppet() },
    })

    await awaitVisibleStep('left', 'plan', { timeoutMs: 10_000 })
    await firstHandle.agent('plan').complete()
    await awaitStepStatus('plan', 'completed', { timeoutMs: 5_000 })

    await awaitVisibleStep('left', 'execute', { timeoutMs: 10_000 })
    await firstHandle.agent('execute').fail({ message: 'crash-pre-resume' })
    await awaitRunStatus('failed', { timeoutMs: 10_000 })

    // Wait for the first orch process to finish exiting before resuming —
    // resume reads state.json + lifecycle.ndjson, both written during the
    // first run's teardown.
    await firstHandle.subprocess.wait()

    // Resume the SAME run id against the SAME state base. The resumed
    // invocation gets fresh puppet control files; cached steps don't touch
    // them because the runner is never invoked for cache hits.
    secondHandle = await resumeOrchWorkflow(firstHandle, 'resumable-crash', {
      script: { execute: puppet() },
    })

    await secondHandle.agent('execute').complete()
    await awaitStepStatus('execute', 'completed', { timeoutMs: 15_000 })
    await awaitRunStatus('completed', { timeoutMs: 10_000 })

    await assertPersistedState(
      withinMs(5_000),
      hasRunStatus('completed'),
      hasStepCompleted('plan'),
      hasStepCompleted('execute'),
    )
  }, 60_000)
})
