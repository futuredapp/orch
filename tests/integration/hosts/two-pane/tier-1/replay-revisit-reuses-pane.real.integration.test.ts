// triage: keep — Tier 1 warm-cache invariant.
//
// The right-pane controller's `live → replay` transform is supposed to keep
// the hidden source pane alive after a step completes, so opening replay on
// that step never has to respawn the pane. This test pins the visible
// outcome: the scratch session's pane count after the workflow ends matches
// what registerSource produced — no extra panes get created on revisit.

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
    it('the scratch-session pane count is stable across two right-pane captures after step:complete', async () => {
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

      const scratchBefore = await fixture.tmux.listPanes({
        socket: fixture.socket,
        session: 'orch-scratch',
        format: '#{pane_id}',
      })

      // Re-capture the right pane — under warm-cache, no new pane is spawned
      // and the existing replay pane is reused.
      await harness.right.capture()
      await harness.right.capture()

      const scratchAfter = await fixture.tmux.listPanes({
        socket: fixture.socket,
        session: 'orch-scratch',
        format: '#{pane_id}',
      })
      expect(scratchAfter).toEqual(scratchBefore)
    }, 15_000)
  },
)
