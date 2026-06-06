/**
 * Behavioral cell — `ask(...)` with `defaultWhenNoninteractive` resolves
 * non-interactively when orch is launched with `--noninteractive`. The run
 * does not block on the ask; the following step runs to completion.
 */

import { afterEach, beforeEach, describe, it } from 'bun:test'
import {
  assertPersistedState,
  awaitRunStatus,
  awaitStepStatus,
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

// MIGRATED → tests-new/lifecycle/side-effects/ask-noninteractive-uses-default.test.ts — parent U8 (G4).
// port: non-blocking behaviour (ask resolves its default; next step completes).
describe.skipIf(!canRunRealTmux())(
  'Tier 5 behavioral — ask resolves default in noninteractive',
  () => {
    it.skip('--noninteractive resolves the ask to its declared default and the next step runs', async () => {
      handle = await launchOrchWorkflow('ask-with-default', {
        script: { after: puppet() },
        cliArgs: ['--noninteractive'],
      })

      // The ask step resolves itself; we then drive `after` to complete.
      await awaitStepStatus('ask:continue', 'completed', { timeoutMs: 15_000 })

      await handle.agent('after').complete()
      await awaitStepStatus('after', 'completed', { timeoutMs: 10_000 })
      await awaitRunStatus('completed', { timeoutMs: 10_000 })

      await assertPersistedState(
        withinMs(5_000),
        hasStepCompleted('ask:continue'),
        hasStepCompleted('after'),
      )
    }, 30_000)
  },
)
