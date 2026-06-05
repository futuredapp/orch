// triage: keep — Tier 1 multi-step follow-live auto-advance invariant.
//
// All other Tier 1 starters drive a single-step workflow. The second
// step's lifecycle is its own bug class: when `plan` completes (its live
// pane transforms to a warm replay cache) and `refine` starts, a user who
// never navigated away is still tracking the live edge, so the visible
// right pane must AUTO-ADVANCE to `refine`. The regression
// (run r-2026-05-29-104450-sx) left the view pinned to `plan` because step
// completion wrongly cleared follow mode. We also assert plan's warm replay
// session survived the transition (it must not be killed on refine's start),
// so a later `f`/Enter can still revisit it.

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

// MIGRATED → tests-new/full-host/fake-agent/multi-step--right-pane-auto-advances.test.ts — parent U6a.4.
// port: right pane auto-advances to the new live step; the first stays revisitable.
describe.skipIf(!tmuxAvailable)(
  "Tier 1 — first step's warm-cached replay survives the second step starting",
  () => {
    it.skip('after the first step completes, the right pane auto-advances to the second live step while the first stays warm-cached', async () => {
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

      // The user never navigated away, so they are still tracking the live
      // edge. When plan completes and refine starts, the visible right pane
      // auto-advances to refine's content.
      // The choreographer writes a `[<step>] starting…` marker into each
      // step's tee on `step:start`, and only that step's per-source pane tails
      // it — so seeing refine's marker in the VISIBLE right pane proves the
      // pane advanced onto refine's live source. (We assert the marker rather
      // than refine's transcript text because the runner-event flush races
      // teardown under instant FakeRunners; the marker is deterministic.)
      await harness.right.waitForText('[refine] starting', { timeoutMs: 5000 })
      const frame = await harness.right.capture()
      expect(frame).toContain('[refine] starting')
      expect(frame).not.toContain('planning the work')

      // plan's live pane was rekeyed to a warm replay cache, NOT killed: its
      // per-source session (named after the original `live:plan` key) still
      // exists, so revisiting plan later is an O(1) swap.
      const planPanes = await fixture.tmux.listPanes({
        socket: fixture.socket,
        session: 'orch-src-live-plan',
        format: '#{pane_id}',
      })
      expect(planPanes).toHaveLength(1)
    }, 20_000)
  },
)
