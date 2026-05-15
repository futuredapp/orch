// triage: keep — Tier 1 multi-step pane-survival invariant.
//
// All other Tier 1 starters drive a single-step workflow. The second
// step's lifecycle is its own bug class: when `plan` completes (live
// → replay transforms its pane, view-mode flips to replay) and
// `refine` starts (registers as a *hidden* live source because the
// user is now on replay), the *first* step's warm-cached replay
// pane must remain visible. A regression that killed plan's hidden
// pane on refine's registerSource — or that auto-swapped to refine
// despite the user being on replay — would leave the user staring
// at an empty pane or stale wrong-step content.

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
  "Tier 1 — first step's warm-cached replay survives the second step starting",
  () => {
    it('after two sequential steps complete, the right pane still shows the first step transcript and does not auto-jump to the second', async () => {
      const fixture = await createRealTmuxFixture({ env: {} })
      fixturesToDispose.push(fixture)
      const agentProcessService = new FakeProcessService()
      const harness = await mountTmuxHost(fixture, {
        disableStepsView: true,
        agentProcessService,
      })
      harnessesToTeardown.push(harness)

      const planAgent = new FakeRunner(agentProcessService)
      planAgent.script({
        events: [{ kind: 'info', type: 'assistant', payload: { text: 'planning the work' } }],
        structuredOutput: 'plan-done',
      })

      const refineAgent = new FakeRunner(agentProcessService)
      refineAgent.script({
        events: [{ kind: 'info', type: 'assistant', payload: { text: 'refining the plan' } }],
        structuredOutput: 'refine-done',
      })

      const run = await harness.runWorkflow([
        { name: 'plan', agent: planAgent },
        { name: 'refine', agent: refineAgent },
      ])
      expect(run.completed).toBe(true)

      // The user was on plan's live view; live→replay flipped them to
      // replay mode. refine's registerSource sees mode==='replay' and
      // registers as a hidden source without swapping. The visible
      // right pane stays on plan's warm-cached replay.
      await harness.right.waitForText('planning the work', { timeoutMs: 5000 })
      const frame = await harness.right.capture()
      expect(frame).toContain('planning the work')
      expect(frame).not.toContain('refining the plan')
    }, 20_000)
  },
)
