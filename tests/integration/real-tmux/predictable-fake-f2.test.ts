// U7 (headless slice) — F2 acceptance: drive parallel branches and concurrent
// runs independently with no cross-talk. These ride entirely on headless fakes
// (no TUI), so they belong to Phase 1. The interactive F1 flow + manual-typing
// acceptance are Phase 2.
//
// Every assertion is gated on a durable on-disk signal: control acks, the
// `.ready` marker, and each step's `formatted_output.txt` tee (the durable
// render oracle) — never a bare pane scrape (Tier-5 findings).

import { afterEach, describe, expect, it } from 'bun:test'
import { stat } from 'node:fs/promises'
import {
  canRunRealTmux,
  createRealTmuxFixture,
  type MountedHarness,
  mountTmuxHost,
  REAL_TMUX_TEST_TIMEOUT_MS,
  type RealTmuxFixture,
  readWhenContains,
  teeTxt,
} from '@orch/test/real-tmux/index.ts'
import { runId as toRunId } from '../../../src/state/index.ts'

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

async function mount(
  opts: Parameters<typeof createRealTmuxFixture>[0] = { env: {} },
): Promise<Mounted> {
  const fixture = await createRealTmuxFixture(opts)
  fixturesToDispose.push(fixture)
  const harness = await mountTmuxHost(fixture, { disableStepsView: true })
  harnessesToTeardown.push(harness)
  return { harness, fixture }
}

// The per-step formatted_output tee path for THIS harness's run. The durable
// render oracle: a branch's output is here regardless of which pane is live at
// teardown.
function teeFor(m: Mounted, key: string): string {
  return teeTxt(String(m.harness.stateStore.runDir(m.fixture.runId)), key)
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

describe.skipIf(!tmuxAvailable)(
  'U7 F2 — parallel branches via the control channel (R9, AE4)',
  () => {
    it(
      'delivers each branch only its own type_and_send text',
      async () => {
        const m = await mount()
        const a = m.harness.agent('a')
        const b = m.harness.agent('b')

        const run = m.harness.runPuppetWorkflow([
          {
            parallel: [
              { name: 'fake', as: 'a' },
              { name: 'fake', as: 'b' },
            ],
          },
        ])

        await a.waitForReady()
        await b.waitForReady()
        await a.typeAndSend('to-a')
        await b.typeAndSend('to-b')
        await a.finish()
        await b.finish()

        expect((await run).completed).toBe(true)

        const aOut = await readWhenContains(teeFor(m, 'a'), 'to-a')
        const bOut = await readWhenContains(teeFor(m, 'b'), 'to-b')
        expect(aOut).not.toContain('to-b')
        expect(bOut).not.toContain('to-a')
      },
      REAL_TMUX_TEST_TIMEOUT_MS,
    )
  },
)

describe.skipIf(!tmuxAvailable)('U7 F2 — concurrent runs are isolated (AE3, R11)', () => {
  it(
    'finishing one run does not end the other; handles never resolve the wrong run',
    async () => {
      // Distinct runIds → distinct sockets (orch-<runId>) and state dirs, so
      // each harness's agent() resolves only that run's control files.
      const runA = toRunId('r-2026-06-02-100000-aa')
      const runB = toRunId('r-2026-06-02-100001-bb')
      const A = await mount({ env: {}, runId: runA })
      const B = await mount({ env: {}, runId: runB })

      const aAgent = A.harness.agent('s')
      const bAgent = B.harness.agent('s')

      // Structural isolation: identically-labeled steps map to different files.
      expect(aAgent.controlPath).not.toBe(bAgent.controlPath)

      const aRun = A.harness.runPuppetWorkflow([{ name: 's' }])
      const bRun = B.harness.runPuppetWorkflow([{ name: 's' }])

      await aAgent.waitForReady()
      await bAgent.waitForReady()

      // Finish only run A.
      await aAgent.finish()
      expect((await aRun).completed).toBe(true)

      // Run B is unaffected: its instance is still alive and idle (marker
      // present), and still accepts + acks a command — which would time out if
      // A's finish had torn B down.
      expect(await exists(bAgent.readyPath)).toBe(true)
      await bAgent.typeAndSend('still-alive')
      await bAgent.finish()
      expect((await bRun).completed).toBe(true)
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )
})
