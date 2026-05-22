// triage: keep — Tier 1 warm-cache invariant.
//
// The right-pane controller's `live → replay` transform is supposed to keep
// the hidden source pane alive after a step completes, so opening replay on
// that step never has to respawn the pane. This test pins the visible
// outcome: the per-source session's pane count after the workflow ends
// matches what registerSource produced — no extra panes get created on
// revisit. (Note: the live → replay transform rekeys the controller-side
// SourceKey from `live:<step>` to `replay:<step>` but does NOT rename the
// underlying tmux session, so the session name remains `orch-src-live-<step>`
// throughout — see right-pane-controller.ts:transformLiveToReplay.)

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
  'Tier 1 — replay revisits do not respawn the hidden source pane',
  () => {
    it('the per-source session pane count is stable across two right-pane captures after step:complete', async () => {
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
        events: [{ kind: 'info', type: 'assistant', payload: { text: 'first thinking' } }],
        structuredOutput: 'done',
      })

      const run = await harness.runWorkflow([{ name: 'plan', agent }])
      expect(run.completed).toBe(true)
      await harness.right.waitForText('first thinking', { timeoutMs: 3000 })

      const sourceBefore = await fixture.tmux.listPanes({
        socket: fixture.socket,
        session: 'orch-src-live-plan',
        format: '#{pane_id}',
      })

      // Re-capture the right pane — under warm-cache, no new pane is spawned
      // and the existing replay pane is reused.
      await harness.right.capture()
      await harness.right.capture()

      const sourceAfter = await fixture.tmux.listPanes({
        socket: fixture.socket,
        session: 'orch-src-live-plan',
        format: '#{pane_id}',
      })
      expect(sourceAfter).toEqual(sourceBefore)
    }, 15_000)
  },
)
