// U7 (interactive slice) — F1 acceptance + the R6 manual-typing flow.
//
// F1: drive a two-step workflow (step 1 interactive, step 2 headless) to a
// finished state with no timing flakiness. Every assertion is gated on a
// durable on-disk signal — the `.ready` marker, the control `.ack`, the
// interactive render log, the headless transcript tee, and the run's persisted
// `endedAt` — never a bare pane scrape (Tier-5 findings).
//
// R6: a bare line typed into the interactive pane via real `tmux send-keys`
// (manual stdin, NOT the control channel) renders exactly once. This is the
// only scenario that exercises manual typing through a real PTY; the U4
// unit-tier test cannot.

import { afterEach, describe, expect, it } from 'bun:test'
import {
  assertNoLeakedEntries,
  canRunRealTmux,
  createRealTmuxFixture,
  type MountedHarness,
  mountTmuxHost,
  REAL_TMUX_TEST_TIMEOUT_MS,
  type RealTmuxFixture,
  readWhenContains,
  scriptedFakeEntryCount,
  teeTxt,
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

interface Mounted {
  readonly harness: MountedHarness
  readonly fixture: RealTmuxFixture
}

async function mount(): Promise<Mounted> {
  const fixture = await createRealTmuxFixture({ env: {} })
  fixturesToDispose.push(fixture)
  const harness = await mountTmuxHost(fixture, { disableStepsView: true })
  harnessesToTeardown.push(harness)
  return { harness, fixture }
}

// The per-step headless tee path for THIS harness's run (the durable render
// oracle, independent of which pane is live at teardown).
function teeFor(m: Mounted, key: string): string {
  return teeTxt(String(m.harness.stateStore.runDir(m.fixture.runId)), key)
}

describe.skipIf(!tmuxAvailable)('U7 F1 — interactive step 1 → headless step 2', () => {
  it(
    'drives a two-step workflow to a finished state, every assertion gated on a durable signal',
    async () => {
      const m = await mount()
      const baseline = await scriptedFakeEntryCount()
      const s1 = m.harness.agent('s1')
      const s2 = m.harness.agent('s2')

      const run = m.harness.runPuppetWorkflow([
        { name: 's1', as: 's1', mode: 'interactive' },
        { name: 's2', as: 's2' },
      ])

      // Step 1 (interactive): wait for readiness, render a line through the
      // control channel, and assert the fake is visible/waiting. Gate on the
      // durable render log (the race the feature removes), THEN assert the
      // line is actually on the visible right pane — a real two-pane assertion
      // that would fail if the pane were empty, kept non-flaky by the prior gate.
      await s1.waitForReady()
      await s1.typeAndSend('phase-1-line')
      const s1Render = await s1.waitForRender('phase-1-line')
      expect(s1Render).toContain('phase-1-line')
      await m.harness.right.waitForText('phase-1-line')
      await s1.finish()

      // Step 2 (headless): wait for readiness, drive a line, assert it lands in
      // the durable transcript tee, then finish.
      await s2.waitForReady()
      await s2.typeAndSend('phase-2-line')
      const tee = await readWhenContains(teeFor(m, 's2'), 'phase-2-line')
      expect(tee).toContain('phase-2-line')
      await s2.finish()

      expect((await run).completed).toBe(true)

      // The run reached a finished state — assert the persisted `endedAt`, not a
      // non-undefined return value (Tier-5 findings: presence of the terminal
      // record is the reliable oracle).
      const state = await m.harness.stateStore.loadRun(m.fixture.runId)
      expect(state?.status).toBe('completed')
      expect(state?.endedAt).toBeDefined()

      await m.harness.teardown()
      await assertNoLeakedEntries(baseline)
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )
})

describe.skipIf(!tmuxAvailable)('U7 R6 — manual typing through a real PTY', () => {
  it(
    'renders a hand-typed line exactly once via tmux send-keys (manual stdin, not control)',
    async () => {
      const m = await mount()
      const baseline = await scriptedFakeEntryCount()
      const solo = m.harness.agent('solo')

      const run = m.harness.runPuppetWorkflow([{ name: 'solo', as: 'solo', mode: 'interactive' }])
      await solo.waitForReady()

      // Type into the interactive pane the way a human would — literal chars
      // then a real Enter keystroke. Resolve the pane fresh (it moved into the
      // visible slot via swap-pane).
      const rightPaneId = await m.harness.right.paneId
      await m.harness.sendKeysToPaneId(rightPaneId, 'typed-by-hand')
      await m.harness.sendKeysToPaneId(rightPaneId, 'Enter')

      // Gate on the durable render log; assert exactly one occurrence (raw-mode
      // stdin suppresses echo, so the single explicit render is the only one).
      const body = await solo.waitForRender('typed-by-hand')
      const occurrences = body.split('typed-by-hand').length - 1
      expect(occurrences).toBe(1)

      // …and it is actually on the visible pane — the manual keystroke really
      // rendered in the two-pane UI, not just to disk.
      await m.harness.right.waitForText('typed-by-hand')

      // End the step manually too — `exit` typed at the keyboard (R5).
      await m.harness.sendKeysToPaneId(rightPaneId, 'exit')
      await m.harness.sendKeysToPaneId(rightPaneId, 'Enter')

      expect((await run).completed).toBe(true)

      await m.harness.teardown()
      await assertNoLeakedEntries(baseline)
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )
})
