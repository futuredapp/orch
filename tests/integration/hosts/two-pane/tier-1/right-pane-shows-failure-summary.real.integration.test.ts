// triage: keep — Tier 1 right-pane failure narrative.
//
// When a step fails, the host writes a structured failure summary —
// `✗ step "<name>" failed`, the error message, resume + logs hints —
// into the step's tee. The hidden pane tailing that tee then swaps in
// as the visible right pane. The banner-and-error-ttl test only pins
// the *left* pane's error banner; without this test, a regression that
// silently dropped the right-pane failure narrative would still let
// "step plan failed" appear on the left while leaving the user
// staring at a blank or stale right pane.

import { afterEach, describe, expect, it } from 'bun:test'
import { FakeRunner } from '../../../../../src/runners/index.ts'
import { FakeProcessService } from '../../../../../src/services/process/fake-process-service.ts'
import {
  canRunRealTmux,
  createRealTmuxFixture,
  type MountedHarness,
  mountTmuxHost,
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

describe.skipIf(!tmuxAvailable)(
  'Tier 1 — right pane shows the failure summary after step:failed',
  () => {
    it('right.capture() contains the failure headline and error message after the step throws', async () => {
      const fixture = await createRealTmuxFixture({ env: {} })
      fixturesToDispose.push(fixture)
      const agentProcessService = new FakeProcessService()
      const harness = await mountTmuxHost(fixture, {
        disableStepsView: true,
        agentProcessService,
      })
      harnessesToTeardown.push(harness)

      const agent = new FakeRunner(agentProcessService)
      agent.script({
        events: [{ kind: 'info', type: 'assistant', payload: { text: 'about to fail' } }],
        failWith: { message: 'boom: upstream API rejected request', exitCode: 1 },
      })

      const run = await harness.runWorkflow([{ name: 'plan', agent }])
      expect(run.completed).toBe(false)

      // The host writes `renderFailurePanePayload(summary)` into the tee
      // BEFORE unregisterSource → live-to-replay transforms the pane. The
      // hidden pane tailing the tee picks up those bytes and the warm-
      // cached replay then occupies the visible right slot.
      await harness.right.waitForText('plan', { timeoutMs: 5000 })
      const frame = await harness.right.capture()
      expect(frame).toContain('step "plan" failed')
      expect(frame).toContain('boom: upstream API rejected request')
    }, 20_000)
  },
)
