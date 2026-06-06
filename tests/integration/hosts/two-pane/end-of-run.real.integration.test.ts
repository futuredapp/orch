// MIGRATED → tests-new/integration/real-tmux/end-of-run.test.ts
// Phase 4 real-tmux integration: end-of-run summary survives in the left pane.
//
// Boots a real tmux server, mounts the steps-view-runner against a seeded
// state.json marked `status: 'completed'`, then polls the captured pane until
// it shows the end-of-run footer copy (`q to quit · ⏎ to inspect`) and the
// workflow name.
//
// This test deliberately exercises the steps-view-runner as a SUBPROCESS
// reading a seeded state.json (not the in-process host mount), so it does not
// use `mountTmuxHost`. It does use `createRealTmuxFixture` for the socket: that
// gives a unique socket name, the SIGINT/SIGTERM stale-socket reaper, the
// nested-tmux guard, and socket-file cleanup on dispose — the lifecycle this
// file used to hand-roll, which leaked servers and raced a fixed 1.5s sleep
// before capture (the flake surfaced under full-suite load, 2026-05-26).
//
// Gated on `canRunRealTmux()`. Auto-skips otherwise.

import { afterEach, describe, expect, it } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SocketName, TmuxService } from '../../../../src/services/tmux/index.ts'
import { initOrchSession, paneId as toPaneId } from '../../../../src/services/tmux/index.ts'
import { path as toPath } from '../../../../src/services/types.ts'
import {
  canRunRealTmux,
  createRealTmuxFixture,
  REAL_TMUX_TEST_TIMEOUT_MS,
  type RealTmuxFixture,
} from '../../../helpers/real-tmux/index.ts'

const canRun = canRunRealTmux()

const RUNNER_SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../src/hosts/two-pane/steps-view/steps-view-runner.tsx',
)

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// Poll `capture-pane` until it contains `needle`, instead of sleeping a fixed
// interval and hoping the Ink child has mounted + projected its frame. Returns
// the matching capture; throws with the last frame if the budget expires.
async function captureUntil(
  tmux: TmuxService,
  socket: SocketName,
  target: ReturnType<typeof toPaneId>,
  needle: string,
  timeoutMs = 8_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  for (;;) {
    last = await tmux.capturePane({ socket, target })
    if (last.includes(needle)) return last
    if (Date.now() >= deadline) {
      throw new Error(
        `captureUntil: "${needle}" not seen within ${timeoutMs}ms. Last frame:\n${last}`,
      )
    }
    await wait(50)
  }
}

describe.skip('end-of-run summary on real tmux', () => {
  let fixtures: RealTmuxFixture[] = []

  afterEach(async () => {
    for (const f of fixtures) await f.dispose()
    fixtures = []
  })

  it(
    'renders the end-of-run footer when the seeded run is in a terminal state',
    async () => {
      const fixture = await createRealTmuxFixture({ env: {} })
      fixtures.push(fixture)
      const { tmux, fs, socket } = fixture

      const runId = 'r-2026-05-05-000000-cc'
      const stateBase = join(String(fixture.stateBase), '.orch', 'state')
      const stateDir = join(stateBase, runId)
      await mkdir(join(stateDir, 'logs'), { recursive: true })
      // Seed a completed run — `status: 'completed'` drives the projector into
      // the terminal-state branch, which is what the end-of-run footer needs.
      await writeFile(
        join(stateDir, 'state.json'),
        JSON.stringify({
          schemaVersion: 5,
          id: runId,
          status: 'completed',
          workflowName: 'eor-real-smoke',
          startedAt: 0,
          endedAt: 5_000,
          steps: {
            plan: {
              name: 'plan',
              value: null,
              startedAt: 0,
              endedAt: 1_000,
              artifacts: [],
              validations: [],
              transcriptEventCount: 0,
              transcriptTruncated: false,
            },
          },
        }),
      )

      await initOrchSession(tmux, fs, {
        socket,
        session: 'orch',
        width: 200,
        height: 50,
        paneDiedCommand: `run-shell "tmux -L ${socket} wait-for -S pane-exit-#{hook_pane}"`,
      })

      const panes = await tmux.listPanes({ socket, session: 'orch', format: '#{pane_id}' })
      const firstPane = panes[0]
      if (firstPane === undefined) throw new Error('no initial pane')
      const leftPaneId = toPaneId(firstPane)

      const opts = {
        stateDir,
        runId,
        workflowName: 'eor-real-smoke',
        intentsPath: join(stateDir, 'tui-intents.ndjson'),
        basePath: stateBase,
      }
      const optsB64 = Buffer.from(JSON.stringify(opts), 'utf8').toString('base64')

      await tmux.respawnPane({
        socket,
        target: leftPaneId,
        argv: [process.execPath, RUNNER_SCRIPT, '--opts', optsB64],
        killRunning: true,
        cwd: toPath(String(fixture.stateBase)),
      })

      // Poll until the Ink child has mounted and projected the terminal-state
      // frame — a fixed sleep raced the child's startup under suite load.
      const captured = await captureUntil(tmux, socket, leftPaneId, 'eor-real-smoke')
      expect(captured).toContain('eor-real-smoke')
      expect(captured).toContain('q to quit')
      expect(captured).toContain('completed')
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )
})
