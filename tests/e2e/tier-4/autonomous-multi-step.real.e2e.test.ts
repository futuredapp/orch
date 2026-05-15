// triage: keep — Tier 4 starter (R11) for autonomous multi-step real-CLI.
//
// Same test body shape as Tier 1's autonomous-live-pane-shows-content — the
// only difference is the agent slot: a real `ClaudeRunner` instead of a
// FakeRunner. Auto-skips unless tmux + claude are on PATH AND
// `RUN_REAL_TMUX_E2E=1`. Developer-opt-in until a follow-up adds a scheduled
// CI job.

import { afterEach, describe, expect, it } from 'bun:test'
import { claude } from '../../../src/runners/index.ts'
import {
  canRunRealTmuxE2E,
  createRealTmuxFixture,
  type MountedHarness,
  mountTmuxHost,
  type RealTmuxFixture,
} from '../../helpers/real-tmux/index.ts'

const canRun = canRunRealTmuxE2E('claude')

let fixturesToDispose: RealTmuxFixture[] = []
let harnessesToTeardown: MountedHarness[] = []

afterEach(async () => {
  for (const h of harnessesToTeardown) await h.teardown()
  harnessesToTeardown = []
  for (const f of fixturesToDispose) await f.dispose()
  fixturesToDispose = []
})

describe.skipIf(!canRun)('Tier 4 — autonomous multi-step against real Claude', () => {
  it('two real-CLI autonomous steps run to completion and right.capture() shows live transcript text', async () => {
    const fixture = await createRealTmuxFixture({ env: {} })
    fixturesToDispose.push(fixture)
    // No agentProcessService override — Tier 4 uses the fixture's
    // BunProcessService so the real CLI actually spawns.
    const harness = await mountTmuxHost(fixture, {
      disableStepsView: false,
      workflowName: 'tier4-autonomous-multi-step',
    })
    harnessesToTeardown.push(harness)

    const agent = claude()
    const result = await harness.runWorkflow([
      { name: 'plan', agent, prompt: "say literally the word 'banana'" },
      { name: 'work', agent, prompt: "say literally the word 'kiwi'" },
    ])
    expect(result.completed).toBe(true)

    // Live transcript text from the second step lands in the right pane
    // within a Tier-4-generous timeout. Real Claude can take 5–25s per step
    // before its first transcript-renderable byte arrives.
    await harness.right.waitForText('kiwi', { timeoutMs: 30_000 })
  }, 120_000)
})
