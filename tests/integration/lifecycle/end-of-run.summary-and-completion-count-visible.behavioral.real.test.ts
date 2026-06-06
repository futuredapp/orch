/**
 * Behavioral cell — when every step in the workflow completes, the run
 * reaches `completed`, the lifecycle log records `run-ended status:completed`,
 * and the state.json snapshot reports all steps `completed`.
 *
 * The on-pane "run completed · steps N/N completed" summary is rendered for a
 * brief window before `execute-with-attach.ts` tears down the host on
 * successful workflow exit (same teardown race as Group E). The durable
 * signals here are `logs/lifecycle.ndjson`'s `run-ended` entry plus
 * `state.json` — both survive teardown and prove the EndOfRunSummary code
 * path fired with the correct totals.
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

// COVERED BY → tests-new/model/end-of-run--summary-and-count.test.ts (+ screen/end-of-run--summary-and-count-bytes.test.ts) — parent U8 (W6 close-out; U5b area).
// demote→model/screen: the visible end-of-run summary + `steps N/N completed`
// count is covered by the U5b twins. This cell only asserts the durable
// completed-run signals (persisted state + lifecycle.ndjson run-ended) as a
// teardown-race workaround for the unobservable pane.
describe.skipIf(!canRunRealTmux())(
  'Tier 5 behavioral — end-of-run summary records completion',
  () => {
    it.skip('all 3 steps complete, run status=completed, lifecycle.ndjson records run-ended', async () => {
      handle = await launchOrchWorkflow('three-step-linear', {
        script: { plan: puppet(), execute: puppet(), finalize: puppet() },
      })

      await awaitVisibleStep('left', 'plan', { timeoutMs: 10_000 })
      await handle.agent('plan').complete()
      await awaitStepStatus('plan', 'completed', { timeoutMs: 5_000 })

      await handle.agent('execute').complete()
      await awaitStepStatus('execute', 'completed', { timeoutMs: 5_000 })

      await handle.agent('finalize').complete()
      await awaitRunStatus('completed', { timeoutMs: 10_000 })

      await assertPersistedState(
        withinMs(5_000),
        hasRunStatus('completed'),
        hasStepCompleted('plan'),
        hasStepCompleted('execute'),
        hasStepCompleted('finalize'),
      )

      const lifecycleLog = nodePath.join(handle.stateDir, 'logs', 'lifecycle.ndjson')
      await assertFilesystem(
        withinMs(5_000),
        fileContains(lifecycleLog, '"type":"run-ended"'),
        fileContains(lifecycleLog, '"status":"completed"'),
      )
    }, 45_000)
  },
)
