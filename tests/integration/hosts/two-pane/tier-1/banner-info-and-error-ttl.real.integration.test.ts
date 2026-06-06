// MIGRATED → tests-new/integration/real-tmux/banner-info-and-error-ttl.test.ts
// triage: keep — Tier 1 banner visibility on the left pane.
//
// The right-pane controller emits an error banner on `step:failed`. The
// banner is the durable, unconditional signal that something went wrong —
// even when the user is on a replay or rollup view. The steps-view daemon
// renders the banner in the left pane; a regression here would silently
// hide step-failure feedback from the user.
//
// Info-banner + TTL coverage is deferred to U6's audit pass / Tier 2: the
// info-banner trigger paths (registerSource while on replay, live→replay
// transform with a watcher) require concurrent live+replay state that the
// synchronous FakeRunner cannot deterministically produce — Tier 2 covers
// it via `<StepsView>` projection with a hand-rolled banner field.

import { afterEach, describe, expect, it } from 'bun:test'
import { FakeRunner } from '../../../../../src/runners/index.ts'
import { FakeProcessService } from '../../../../../src/services/process/fake-process-service.ts'
import {
  canRunRealTmux,
  createRealTmuxFixture,
  type MountedHarness,
  mountTmuxHost,
  REAL_TMUX_ASSERT_TIMEOUT_MS,
  REAL_TMUX_TEST_TIMEOUT_MS,
  type RealTmuxFixture,
} from '../../../../helpers/real-tmux/index.ts'

const tmuxAvailable = canRunRealTmux()

let fixturesToDispose: RealTmuxFixture[] = []
let harnessesToTeardown: MountedHarness[] = []

afterEach(async () => {
  for (const h of harnessesToTeardown) await h.teardown()
  harnessesToTeardown = []
  for (const f of fixturesToDispose) await f.dispose()
  fixturesToDispose = []
})

describe.skip('Tier 1 — error banner surfaces step failure in the left pane', () => {
  it(
    "step:failed renders 'step plan failed' in the steps-view left pane",
    async () => {
      const fixture = await createRealTmuxFixture({ env: {} })
      fixturesToDispose.push(fixture)
      const agentProcessService = new FakeProcessService()
      const harness = await mountTmuxHost(fixture, {
        disableStepsView: false,
        agentProcessService,
      })
      harnessesToTeardown.push(harness)

      const agent = new FakeRunner(agentProcessService)
      agent.script({
        failWith: { message: 'simulated agent failure', exitCode: 1 },
      })

      // Workflow throws on step failure — `completed: false` is expected.
      const run = await harness.runWorkflow([{ name: 'plan', agent }])
      expect(run.completed).toBe(false)

      await harness.left.waitForText('step plan failed', {
        timeoutMs: REAL_TMUX_ASSERT_TIMEOUT_MS,
      })
      const frame = await harness.left.capture()
      expect(frame).toContain('step plan failed')
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )
})
