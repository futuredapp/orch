// Phase 4 real-tmux integration: end-of-run summary survives in the left pane.
//
// Boots a real tmux server, mounts the steps-view-runner against a seeded
// state.json marked `status: 'completed'`, gives the child time to render,
// and asserts the captured pane shows the end-of-run footer copy
// (`q to quit · ⏎ to inspect`) and the workflow name.
//
// Gated on `Bun.which('tmux')`. Auto-skips otherwise.

import { afterEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BunFsService } from '../../../../src/services/fs/index.ts'
import { BunProcessService } from '../../../../src/services/process/index.ts'
import {
  initOrchSession,
  RealTmuxService,
  type SocketName,
  socketName,
  paneId as toPaneId,
} from '../../../../src/services/tmux/index.ts'
import { path as toPath } from '../../../../src/services/types.ts'

const canRun = Bun.which('tmux') !== null

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

const newSocket = (tag: string): SocketName => {
  const s = socketName(`orch-eor-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
  sockets.push(s)
  return s
}

const RUNNER_SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../src/hosts/two-pane/steps-view/steps-view-runner.tsx',
)

describe.skipIf(!canRun)('end-of-run summary on real tmux', () => {
  it('renders the end-of-run footer when the seeded run is in a terminal state', async () => {
    const baseTmp = await mkdtemp(join(tmpdir(), 'orch-eor-real-'))
    dirsToClean.push(baseTmp)
    const runId = 'r-2026-05-05-000000-cc'
    const stateBase = join(baseTmp, '.orch', 'state')
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
      cwd: toPath(baseTmp),
    })

    // Give the Ink child time to mount and project the terminal-state frame.
    await wait(1_500)

    const captured = await tmux.capturePane({ socket, target: leftPaneId })
    expect(captured).toContain('eor-real-smoke')
    expect(captured).toContain('q to quit')
    expect(captured).toContain('completed')
  }, 10_000)
})
