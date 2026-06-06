// Three-step predictable-fake run: interactive → interactive → headless.
//
// Extends the F1 acceptance shape (interactive step 1 → headless step 2) to a
// three-step sequence with TWO interactive steps ahead of a final headless one.
// It drives a single real-tmux run to a finished state, every assertion gated
// on a durable on-disk signal — the per-instance `.ready` marker, the control
// `.ack` (awaited inside `typeAndSend`/`finish`), the interactive render log,
// the headless transcript tee, and the run's persisted `endedAt` — never a bare
// pane scrape (Tier-5 findings).
//
// Why this is a distinct test from F1: it exercises interactive→interactive
// hand-off (a second interactive PTY step starting after the first cleanly
// exits) plus the interactive→headless transition, all within one run, and
// confirms no scripted-fake daemon leaks across three sequential instances.

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
} from '@orch/test/real-tmux/index.ts'

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

describe.skipIf(!tmuxAvailable)(
  'predictable fake — interactive step 1 → interactive step 2 → headless step 3',
  () => {
    it(
      'drives a three-step run to a finished state, every assertion gated on a durable signal',
      async () => {
        const m = await mount()
        const baseline = await scriptedFakeEntryCount()
        const s1 = m.harness.agent('s1')
        const s2 = m.harness.agent('s2')
        const s3 = m.harness.agent('s3')

        const run = m.harness.runPuppetWorkflow([
          { name: 's1', as: 's1', mode: 'interactive' },
          { name: 's2', as: 's2', mode: 'interactive' },
          { name: 's3', as: 's3' },
        ])

        // Step 1 (interactive): wait for readiness, render a line through the
        // control channel, gate on the durable render log (the race the feature
        // removes), THEN assert the line is on the visible right pane — a real
        // two-pane assertion that would fail if the pane were empty, kept
        // non-flaky by the prior gate. Then finish cleanly.
        await s1.waitForReady()
        await s1.typeAndSend('phase-1-line')
        const s1Render = await s1.waitForRender('phase-1-line')
        expect(s1Render).toContain('phase-1-line')
        await m.harness.right.waitForText('phase-1-line')
        await s1.finish()

        // Step 2 (interactive): a SECOND interactive PTY step must start after
        // the first cleanly exited. Same durable-render + visible-pane oracle.
        await s2.waitForReady()
        await s2.typeAndSend('phase-2-line')
        const s2Render = await s2.waitForRender('phase-2-line')
        expect(s2Render).toContain('phase-2-line')
        await m.harness.right.waitForText('phase-2-line')
        await s2.finish()

        // Step 3 (headless): wait for readiness, drive a line, assert it lands
        // in the durable transcript tee, then finish.
        await s3.waitForReady()
        await s3.typeAndSend('phase-3-line')
        const tee = await readWhenContains(teeFor(m, 's3'), 'phase-3-line')
        expect(tee).toContain('phase-3-line')
        await s3.finish()

        expect((await run).completed).toBe(true)

        // The run reached a finished state — assert the persisted `endedAt`, not
        // a non-undefined return value (Tier-5 findings: presence of the
        // terminal record is the reliable oracle).
        const state = await m.harness.stateStore.loadRun(m.fixture.runId)
        expect(state?.status).toBe('completed')
        expect(state?.endedAt).toBeDefined()

        await m.harness.teardown()
        await assertNoLeakedEntries(baseline)
      },
      REAL_TMUX_TEST_TIMEOUT_MS,
    )
  },
)
