// MIGRATED → tests-new/integration/real-tmux/predictable-fake-ink.test.ts (parent U13) — relocated verbatim (import paths only); kept skipped on disk (D2).
// Real-tmux acceptance for the Ink interactive entry (`ink-entry.tsx`).
//
// The ink-view component is unit-covered via ink-testing-library; this test
// proves the BOOTSTRAP runs as a real PTY process in a tmux pane: it reaches
// readiness, renders a control-driven line into the durable render log AND onto
// the visible right pane (Ink list), and exits cleanly on `finish` — with no
// leaked scripted-fake daemons. Every assertion is gated on a durable on-disk
// signal first (the `.ready` marker, the control `.ack` awaited inside
// `typeAndSend`/`finish`, the render log), then the visible-pane scrape — so the
// two-pane assertion is real but non-flaky (Tier-5 findings).

import { afterEach, describe, expect, it } from 'bun:test'
import {
  assertNoLeakedEntries,
  canRunRealTmux,
  createRealTmuxFixture,
  type MountedHarness,
  mountTmuxHost,
  REAL_TMUX_TEST_TIMEOUT_MS,
  type RealTmuxFixture,
  scriptedFakeEntryCount,
} from '../../helpers/real-tmux/index.ts'

const tmuxAvailable = canRunRealTmux()

let fixturesToDispose: RealTmuxFixture[] = []
let harnessesToTeardown: MountedHarness[] = []

afterEach(async () => {
  for (const h of harnessesToTeardown) await h.teardown()
  harnessesToTeardown = []
  for (const f of fixturesToDispose) await f.dispose()
  fixturesToDispose = []
})

async function mount(): Promise<{ harness: MountedHarness; fixture: RealTmuxFixture }> {
  const fixture = await createRealTmuxFixture({ env: {} })
  fixturesToDispose.push(fixture)
  const harness = await mountTmuxHost(fixture, { disableStepsView: true })
  harnessesToTeardown.push(harness)
  return { harness, fixture }
}

describe.skip('Ink interactive entry — real PTY in a tmux pane', () => {
  it(
    'drives an Ink step: control line renders to the log and the visible pane, then finishes',
    async () => {
      const m = await mount()
      const baseline = await scriptedFakeEntryCount()
      const solo = m.harness.agent('solo')

      const run = m.harness.runPuppetWorkflow([
        { name: 'solo', as: 'solo', mode: 'interactive', ui: 'ink' },
      ])

      await solo.waitForReady()
      await solo.typeAndSend('ink-line')
      const render = await solo.waitForRender('ink-line')
      expect(render).toContain('ink-line')
      await m.harness.right.waitForText('ink-line')
      await solo.finish()

      expect((await run).completed).toBe(true)

      const state = await m.harness.stateStore.loadRun(m.fixture.runId)
      expect(state?.status).toBe('completed')

      await m.harness.teardown()
      await assertNoLeakedEntries(baseline)
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )
})
