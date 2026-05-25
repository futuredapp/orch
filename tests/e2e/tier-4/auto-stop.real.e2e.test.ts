// triage: keep — Tier 4 end-to-end proof (AE2) that interactive auto-stop
// closes a finished Claude turn with NO keystroke. This is the only layer that
// exercises the real inline-hook injection + real env inheritance + real tmux
// `wait-for` transport that the Tier 1 fake cannot. Env-gated and
// developer-opt-in (`RUN_REAL_TMUX_E2E=1` + `claude` on PATH); auto-skips in
// normal CI.

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

describe.skipIf(!canRun)('Tier 4 — interactive auto-stop (real Claude)', () => {
  it('finishes its turn and the pane closes on its own with no keystroke', async () => {
    const fixture = await createRealTmuxFixture({ env: {} })
    fixturesToDispose.push(fixture)
    const harness = await mountTmuxHost(fixture, { disableStepsView: false })
    harnessesToTeardown.push(harness)

    // A prompt that finishes a turn quickly. The real Stop hook the runner
    // injected fires the real `tmux -L $ORCH_SOCKET wait-for -S
    // $ORCH_STOP_CHANNEL` signal; orch races it, terminates the pane, and the
    // workflow resolves — no keystroke is ever sent.
    const result = await harness.runWorkflow([
      {
        name: 'brainstorm',
        agent: claude(),
        mode: 'interactive',
        autoStop: true,
        prompt: 'Reply with exactly the word "done" and nothing else.',
      },
    ])

    expect(result.completed).toBe(true)
  }, 120_000)
})
