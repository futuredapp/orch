// triage: keep — Tier 1 visible-pane regression coverage (covers AE1).
//
// After an autonomous step ends, the live source is transformed into a warm-
// cached replay source. The transcript bytes the user just watched live must
// still be visible — without this, "press Enter to inspect the completed
// step" would show a blank pane. The right-pane controller's `live → replay`
// transform is what guards this; this test pins its visible-pane outcome
// rather than the recordedCalls shape the legacy mocked tests asserted.

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

// MIGRATED → tests-new/full-host/fake-agent/replay--revisit-shows-same-transcript.test.ts — parent U6a.4.
// port: the transcript persists in the right pane after the run ends.
describe.skipIf(!tmuxAvailable)(
  'Tier 1 — replay of a completed autonomous step shows the same transcript as live',
  () => {
    it.skip('after the workflow ends, right.capture() still contains both transcript lines', async () => {
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
        events: [
          { kind: 'info', type: 'assistant', payload: { text: 'first thinking' } },
          { kind: 'info', type: 'assistant', payload: { text: 'second thinking' } },
        ],
        structuredOutput: 'done',
      })

      const run = await harness.runWorkflow([{ name: 'plan', agent }])
      expect(run.completed).toBe(true)

      // The live source was transformed to a warm-cached replay on step:complete;
      // its hidden pane is still tailing the tee. Visible content survives.
      await harness.right.waitForText('first thinking', { timeoutMs: 3000 })
      const replayFrame = await harness.right.capture()
      expect(replayFrame).toContain('first thinking')
      expect(replayFrame).toContain('second thinking')
    }, 15_000)
  },
)
