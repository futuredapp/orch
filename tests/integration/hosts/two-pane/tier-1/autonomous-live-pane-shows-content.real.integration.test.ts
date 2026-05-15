// triage: keep — Tier 1 visible-pane regression coverage (covers AE1 partial).
//
// The "right pane is empty after step:start" bug class is exactly what this
// test catches: an autonomous step's transcript bytes must reach the visible
// right pane within a bounded window, with no caret-notation echo artifacts.
// A green run here means a user can press ↵ on an autonomous step and see
// transcript movement — the foundation the rest of Tier 1 builds on.

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
  'Tier 1 — autonomous step live pane shows content within a bounded window',
  () => {
    it('right.waitForText resolves before its timeout, both transcript lines are visible, and no caret-notation echo bytes appear', async () => {
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

      await harness.right.waitForText('first thinking', { timeoutMs: 3000 })
      const visible = await harness.right.capture()
      expect(visible).toContain('first thinking')
      expect(visible).toContain('second thinking')
      // Caret-notation echo (`^[`, `^M`, `^J`) is the calling card of the legacy
      // pty doubling bug. The file-tail model cannot emit these — pin it.
      expect(visible).not.toContain('^[')
      expect(visible).not.toContain('^M')
      expect(visible).not.toContain('^J')
    }, 15_000)
  },
)
