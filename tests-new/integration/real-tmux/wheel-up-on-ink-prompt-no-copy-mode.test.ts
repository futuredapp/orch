// Behavioural Tier-1 test: wheel-up on an open `ask()` prompt must keep the
// visible right pane out of copy-mode.
//
// Incident r-2026-05-22-212450-07: user reported "the custom input visually
// disappeared" while scrolling. Root cause: the smart-wheel binding from
// `session-init.ts` enters copy-mode when both `mouse_any_flag = 0` and
// `alternate_on = 0`. The InkPromptService child renders WITHOUT alt-screen,
// so wheel-up traps the pane in copy-mode, hiding the live Ink prompt under
// scrollback. The steps-view child renders WITH alt-screen and is unaffected.
//
// We can't faithfully synthesize a wheel event through `tmux send-keys` (see
// wheel-no-mode-error.real.test.ts header note), so we pin the gating flag
// the keybinding actually consults: `alternate_on` on the prompt pane. With
// `alternate_on = 1` the smart-wheel takes its safe `send-keys -M` branch;
// with `alternate_on = 0` it falls through to `copy-mode -e` and the bug
// manifests. Today the runner mounts Ink without alt-screen so this reads
// '0'; after the fix (`alternateScreen: true` on `render()`) it reads '1'.

import { afterEach, describe, expect, it } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stepName as makeStepName } from '../../../src/core/types.ts'
import type { PromptSpec } from '../../../src/services/prompt/index.ts'
import { path as toPath } from '../../../src/services/types.ts'
import {
  canRunRealTmux,
  createRealTmuxFixture,
  type MountedHarness,
  mountTmuxHost,
  type RealTmuxFixture,
} from '@orch/test/real-tmux/index.ts'

const tmuxAvailable = canRunRealTmux()

const here = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(here, '..', '..', '..')
const RUNNER = join(REPO_ROOT, 'src', 'services', 'prompt', 'ink-runner.ts')

let fixturesToDispose: RealTmuxFixture[] = []
let harnessesToTeardown: MountedHarness[] = []

afterEach(async () => {
  for (const h of harnessesToTeardown) await h.teardown().catch(() => {})
  harnessesToTeardown = []
  for (const f of fixturesToDispose) await f.dispose().catch(() => {})
  fixturesToDispose = []
})

describe.skipIf(!tmuxAvailable)(
  'two-pane host — wheel-up on an open ink-prompt keeps the pane out of copy-mode',
  () => {
    it('the visible right pane reports alternate_on == 1 while the prompt is open so the smart-wheel binding does not enter copy-mode', async () => {
      const fixture = await createRealTmuxFixture({ env: {} })
      fixturesToDispose.push(fixture)
      const harness = await mountTmuxHost(fixture, { disableStepsView: true })
      harnessesToTeardown.push(harness)

      const tmpDir = String(fixture.stateBase)
      const resultPath = `${tmpDir}/ink-prompt-result.json`
      const spec: PromptSpec = {
        question: 'WHEEL-PROBE-MARKER',
        fields: [],
        buttons: ['ok'],
      }
      const specB64 = Buffer.from(JSON.stringify(spec), 'utf8').toString('base64')

      // Kick the prompt off in the background; teardown will resolve it.
      const promptDone = harness.host
        .runInteractive({
          argv: [process.execPath, RUNNER, '--spec', specB64, '--result', resultPath],
          env: {} as Readonly<Record<string, string>>,
          cwd: toPath(tmpDir),
          stepName: makeStepName('wheel-up-check'),
        })
        .catch((err: unknown) => err)

      await harness.right.waitForText('WHEEL-PROBE-MARKER', { timeoutMs: 8000 })

      const paneId = await harness.right.paneId

      const probe = Bun.spawn(
        [
          'tmux',
          '-L',
          String(fixture.socket),
          'display-message',
          '-p',
          '-t',
          String(paneId),
          '#{?alternate_on,1,0}',
        ],
        { stdout: 'pipe', stderr: 'ignore' },
      )
      const probeOut = (await new Response(probe.stdout).text()).trim()
      await probe.exited

      // Contract: alt-screen is on, so the smart-wheel binding (which keys on
      // `#{?alternate_on,1,0}`) takes the `send-keys -M` branch instead of
      // `copy-mode -e`. The prompt UI stays visible under wheel-up.
      expect(probeOut).toBe('1')

      // Suppress unawaited-promise warning; afterEach teardown resolves it.
      void promptDone
    }, 30_000)
  },
)
