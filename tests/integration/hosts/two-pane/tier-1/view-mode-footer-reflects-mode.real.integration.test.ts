// triage: keep — Tier 1 visible-pane regression coverage (R10 scope).
//
// The left pane is the steps view. After a workflow reaches a terminal
// state, the footer must render the published end-of-run copy
// (`q to quit · ⏎ to inspect`) and the workflow name + step list — the
// canonical signal that "the run is done". A regression here would surface
// as a blank or stale left pane after completion.

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

describe.skipIf(!tmuxAvailable)('Tier 1 — view-mode footer reflects the current mode', () => {
  it('after the workflow completes, the left pane renders the terminal-state footer and the workflow name', async () => {
    const fixture = await createRealTmuxFixture({ env: {} })
    fixturesToDispose.push(fixture)
    const agentProcessService = new FakeProcessService()
    const harness = await mountTmuxHost(fixture, {
      disableStepsView: false,
      agentProcessService,
      workflowName: 'tier1-view-mode-smoke',
    })
    harnessesToTeardown.push(harness)

    const agent = new FakeRunner(agentProcessService)
    agent.script({
      events: [{ kind: 'info', type: 'assistant', payload: { text: 'hello' } }],
      structuredOutput: 'done',
    })

    const run = await harness.runWorkflow([{ name: 'plan', agent }])
    expect(run.completed).toBe(true)

    // Steps-view daemon needs a beat to repaint after the run-ended signal.
    await harness.left.waitForText('run completed', { timeoutMs: 5000 })
    const frame = await harness.left.capture()

    expect(frame).toContain('tier1-view-mode-smoke')
    expect(frame).toContain('plan')
    expect(frame).toContain('q to quit')
    expect(frame).toContain('inspect')
  }, 20_000)
})
