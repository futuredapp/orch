// Real-tmux integration for the steps-view daemon. Boots a tmux server,
// spawns the Ink steps-view-runner script as a real child onto the left
// pane, gives it ~600ms to read the seeded `state.json` and render, then
// captures the pane and asserts the workflow name + step name appear.
//
// Gated on `canRunRealTmux()` — auto-skips on hosts without tmux installed and
// when ORCH_DISABLE_REAL_TMUX=1 (PR CI; see canRunRealTmux for the AE3 rule).

import { afterEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  allocateSocketName,
  canRunRealTmux,
  REAL_TMUX_ASSERT_TIMEOUT_MS,
  REAL_TMUX_TEST_TIMEOUT_MS,
} from '@orch/test/real-tmux/index.ts'
import { BunFsService } from '../../../src/services/fs/index.ts'
import { BunProcessService } from '../../../src/services/process/index.ts'
import {
  initOrchSession,
  RealTmuxService,
  type SocketName,
  socketName,
  paneId as toPaneId,
} from '../../../src/services/tmux/index.ts'
import { path as toPath } from '../../../src/services/types.ts'

const canRun = canRunRealTmux()

const killServer = async (socket: SocketName): Promise<void> => {
  const proc = Bun.spawn(['tmux', '-L', socket, 'kill-server'], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  await proc.exited
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let sockets: SocketName[] = []
let dirsToClean: string[] = []

afterEach(async () => {
  for (const s of sockets) await killServer(s)
  sockets = []
  for (const d of dirsToClean) {
    await rm(d, { recursive: true, force: true }).catch(() => {})
  }
  dirsToClean = []
})

// Reserved `orch-test-<pid>-<nonce>` socket (KTD-1) with the debug tag appended
// after the pid so the stale-socket preload can reap a crashed leak by liveness.
const newSocket = (tag: string): SocketName => {
  const s = socketName(`${allocateSocketName()}-${tag}`)
  sockets.push(s)
  return s
}

// Resolve runner script via this test file's location — no `import.meta.url`
// gymnastics in the test, just a relative resolve.
const RUNNER_SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../src/hosts/two-pane/steps-view/steps-view-runner.tsx',
)

describe.skipIf(!canRun)('steps-view-runner against a real tmux server', () => {
  it(
    'renders the seeded workflow name and step name into the left pane',
    async () => {
      const baseTmp = await mkdtemp(join(tmpdir(), 'orch-stepstui-real-'))
      dirsToClean.push(baseTmp)
      const runId = 'r-2026-04-13-000000-aa'
      const stateBase = join(baseTmp, '.orch', 'state')
      const stateDir = join(stateBase, runId)
      await mkdir(join(stateDir, 'logs'), { recursive: true })
      await writeFile(
        join(stateDir, 'state.json'),
        JSON.stringify({
          schemaVersion: 5,
          id: runId,
          status: 'running',
          workflowName: 'real-tmux-smoke',
          startedAt: 0,
          steps: {
            plan: {
              name: 'plan',
              value: null,
              startedAt: 0,
              endedAt: 100,
              artifacts: [],
              validations: [],
              transcriptEventCount: 0,
              transcriptTruncated: false,
            },
          },
        }),
      )

      const tmux = new RealTmuxService({ processService: new BunProcessService() })
      const fs = new BunFsService()
      const socket = newSocket('render')
      await initOrchSession(tmux, fs, {
        socket,
        session: 'orch',
        width: 200,
        height: 50,
        paneDiedCommand: `run-shell "tmux -L ${socket} wait-for -S pane-exit-#{hook_pane}"`,
      })

      // Capture the initial pane id, then respawn it with the runner script.
      const panes = await tmux.listPanes({ socket, session: 'orch', format: '#{pane_id}' })
      const firstPane = panes[0]
      if (firstPane === undefined) throw new Error('no initial pane')
      const leftPaneId = toPaneId(firstPane)

      const opts = {
        stateDir,
        runId,
        workflowName: 'real-tmux-smoke',
        intentsPath: join(stateDir, 'tui-intents.ndjson'),
        basePath: stateBase,
      }
      const optsB64 = Buffer.from(JSON.stringify(opts), 'utf8').toString('base64')

      await tmux.respawnPane({
        socket,
        target: leftPaneId,
        argv: [process.execPath, RUNNER_SCRIPT, '--opts', optsB64],
        killRunning: true,
        cwd: toPath(baseTmp),
      })

      // Poll the captured pane until both expected markers appear, or fail
      // with the last-captured frame on timeout. A static `wait(1500)` was
      // brittle here: bun child startup + Ink mount + first frame can stack
      // past 1.5s on a loaded macOS machine.
      const deadline = Date.now() + REAL_TMUX_ASSERT_TIMEOUT_MS
      let captured = ''
      while (Date.now() < deadline) {
        captured = await tmux.capturePane({ socket, target: leftPaneId })
        if (captured.includes('real-tmux-smoke') && captured.includes('plan')) break
        await wait(100)
      }
      // The header line is `orch · <workflowName> · <runId>` and the step row
      // contains the step name. Both must appear in the captured pane content.
      expect(captured).toContain('real-tmux-smoke')
      expect(captured).toContain('plan')
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )
})
