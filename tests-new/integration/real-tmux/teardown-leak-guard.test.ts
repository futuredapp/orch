// U6 — teardown hygiene + leaked-process guard (R14).
//
// Two layers:
//   1. real-tmux: after interactive + headless runs (and after a mid-idle
//      teardown), the tmux-server kill reaps every fake child — the leak guard
//      reports baseline.
//   2. subprocess (no tmux): the interactive entry self-reaps on ORCH_PARENT_PID
//      death, NOT process.ppid. This is the scenario the headless `process.ppid`
//      probe would miss: a tmux-spawned child's ppid is the pane, not orch, so
//      only probing the threaded ORCH_PARENT_PID detects orch's death.

import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import {
  ORCH_PARENT_PID_ENV,
  ORCH_RUN_STATE_DIR_ENV,
  ORCH_STEP_KEY_ENV,
  resolveControlPaths,
  scriptedFake,
} from '../../../src/runners/scripted-fake/index.ts'
import { BunProcessService } from '../../../src/services/process/index.ts'
import { path as toPath } from '../../../src/services/types.ts'
import {
  assertNoLeakedEntries,
  canRunRealTmux,
  createRealTmuxFixture,
  type MountedHarness,
  mountTmuxHost,
  REAL_TMUX_TEST_TIMEOUT_MS,
  type RealTmuxFixture,
  scriptedFakeEntryCount,
} from '@orch/test/real-tmux/index.ts'

const REPO_ROOT = nodePath.resolve(import.meta.dir, '../../..')
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

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

describe.skipIf(!tmuxAvailable)('U6 teardown leak guard (real tmux)', () => {
  it(
    'reaps every fake child after an interactive + headless run',
    async () => {
      const harness = await mount()
      const baseline = await scriptedFakeEntryCount()

      const interactive = harness.agent('a')
      const headless = harness.agent('b')
      const run = harness.runPuppetWorkflow([
        { name: 'a', as: 'a', mode: 'interactive' },
        { name: 'b', as: 'b' },
      ])

      await interactive.waitForReady()
      await interactive.finish()
      await headless.waitForReady()
      await headless.typeAndSend('done')
      await headless.finish()

      expect((await run).completed).toBe(true)

      await harness.teardown()
      await assertNoLeakedEntries(baseline)
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )

  it(
    'leaves no leaked processes when torn down while an instance is mid-idle',
    async () => {
      const harness = await mount()
      const baseline = await scriptedFakeEntryCount()

      const interactive = harness.agent('mid')
      // Hold the run promise; do NOT finish — tear down while the instance is
      // idle-waiting. The tmux-server kill must reap the live PTY child.
      const run = harness.runPuppetWorkflow([{ name: 'mid', as: 'mid', mode: 'interactive' }])
      await interactive.waitForReady()

      await harness.teardown()
      await assertNoLeakedEntries(baseline)

      // The run promise settles (host tears the pane down); we don't assert
      // completion — a mid-flight teardown legitimately fails the step.
      await run
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )
})

describe('U6 interactive self-reap (subprocess, ORCH_PARENT_PID not process.ppid)', () => {
  let runStateDir: string
  let killables: Array<{ kill(): void }> = []

  afterEach(async () => {
    for (const k of killables) {
      try {
        k.kill()
      } catch {
        /* already gone */
      }
    }
    killables = []
    await rm(runStateDir, { recursive: true, force: true }).catch(() => {})
  })

  it('exits within one budget when the threaded ORCH_PARENT_PID dies, even though its real ppid is alive', async () => {
    runStateDir = await mkdtemp(nodePath.join(tmpdir(), 'leak-guard-reap-'))

    // A stand-in "orch" parent whose death we control. The interactive entry's
    // real ppid is THIS test runner (alive throughout) — so an exit here can
    // only come from probing ORCH_PARENT_PID, the property the feature adds.
    const fakeOrch = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' })
    killables.push({ kill: () => fakeOrch.kill() })

    const ps = new BunProcessService()
    const runner = scriptedFake({ stepName: 'reaped', interactive: true })
    const cmd = runner.buildCommand({
      cwd: toPath(runStateDir),
      env: {
        [ORCH_STEP_KEY_ENV]: 'reaped',
        [ORCH_RUN_STATE_DIR_ENV]: runStateDir,
        [ORCH_PARENT_PID_ENV]: String(fakeOrch.pid),
      },
      prompt: 'noop',
      extraArgs: [],
    })
    const handle = ps.spawn({
      argv: cmd.argv,
      env: cmd.env,
      cwd: toPath(REPO_ROOT),
      rawStreams: true,
    })
    killables.push({ kill: () => handle.kill('SIGKILL') })
    void (async () => {
      for await (const _ of handle.stdout) {
        /* drain */
      }
    })()
    void (async () => {
      for await (const _ of handle.stderr) {
        /* drain */
      }
    })()

    const paths = resolveControlPaths({ runStateDir, key: 'reaped' })
    const readyDeadline = Date.now() + 5_000
    while (!(await fileExists(paths.readyPath))) {
      if (Date.now() >= readyDeadline) throw new Error('entry never became ready')
      await new Promise((r) => setTimeout(r, 20))
    }

    // Kill the stand-in parent. The entry's reap loop probes ORCH_PARENT_PID
    // and must exit on the next tick.
    fakeOrch.kill()

    const { exitCode } = await handle.wait()
    expect(exitCode).toBe(0)
  }, 15_000)
})
