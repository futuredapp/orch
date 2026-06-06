// MIGRATED → tests-new/integration/real-tmux/agent-handle.test.ts (parent U13) — relocated verbatim (import paths only); kept skipped on disk (D2).
// U5 — the real-tmux per-instance handle `agent(labelPath)`. A test obtains a
// handle by the author's label and drives exactly that predictable-fake
// instance through its control file, gating every step on a durable on-disk
// signal (`.ready` / `.ack`) rather than a pane scrape.

import { afterEach, describe, expect, it } from 'bun:test'
import { stat } from 'node:fs/promises'
import {
  canRunRealTmux,
  createRealTmuxFixture,
  type MountedHarness,
  mountTmuxHost,
  REAL_TMUX_TEST_TIMEOUT_MS,
  type RealTmuxFixture,
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

async function mount(): Promise<MountedHarness> {
  const fixture = await createRealTmuxFixture({ env: {} })
  fixturesToDispose.push(fixture)
  const harness = await mountTmuxHost(fixture, { disableStepsView: true })
  harnessesToTeardown.push(harness)
  return harness
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

describe.skip('U5 — agent(labelPath) handle', () => {
  it(
    'resolves a control file under the run state dir for the given key (R8)',
    async () => {
      const harness = await mount()

      const handle = harness.agent('s1')

      expect(handle.controlPath).toContain('/test-control/s1.ndjson')
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )

  it(
    'gives two distinct handles for two distinct labels (R9)',
    async () => {
      const harness = await mount()

      const a = harness.agent('a')
      const b = harness.agent('b')

      expect(a.controlPath).not.toBe(b.controlPath)
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )

  it(
    'drives one instance end-to-end: waitForReady, ack-gated typeAndSend, finish (R8, R12, R13)',
    async () => {
      const harness = await mount()
      const agent = harness.agent('s1')

      const run = harness.runPuppetWorkflow([{ name: 's1' }])

      await agent.waitForReady()
      // waitForReady only resolves once the durable marker exists (AE5/R13).
      expect(await exists(agent.readyPath)).toBe(true)

      // typeAndSend / finish resolve only after the instance acked them (R12).
      await agent.typeAndSend('hello')
      await agent.finish()

      const result = await run
      expect(result.completed).toBe(true)
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )

  it(
    'drives two parallel branches independently via their own handles (R9)',
    async () => {
      const harness = await mount()
      const a = harness.agent('a')
      const b = harness.agent('b')

      const run = harness.runPuppetWorkflow([
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

      const result = await run
      expect(result.completed).toBe(true)
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )
})
