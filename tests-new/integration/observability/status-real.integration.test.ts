// Gated real-tmux integration test for the status loop. Creates a session,
// splits a status pane running `cat`, drives lifecycle events through the
// loop, and captures the pane to confirm the rendered glyphs actually made
// it through `send-keys -l`.

import { afterEach, describe, expect, it } from 'bun:test'
import type { StepName } from '../../../src/core/index.ts'
import { startStatusLoop } from '../../../src/observability/index.ts'
import { BunClock, BunProcessService } from '../../../src/services/index.ts'
import {
  paneId,
  RealTmuxService,
  type SocketName,
  socketName,
} from '../../../src/services/tmux/index.ts'
import { allocateSocketName } from '@orch/test/real-tmux/index.ts'

const canRun = Bun.which('tmux') !== null

const killServer = async (socket: SocketName): Promise<void> => {
  const proc = Bun.spawn(['tmux', '-L', socket, 'kill-server'], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  await proc.exited
}

let sockets: SocketName[] = []

// Reserved `orch-test-<pid>-<nonce>` socket (KTD-1) with the debug tag appended
// after the pid so the stale-socket preload can reap a crashed leak by liveness.
const newSocket = (tag: string): SocketName => {
  const s = socketName(`${allocateSocketName()}-${tag}`)
  sockets.push(s)
  return s
}

afterEach(async () => {
  for (const s of sockets) await killServer(s)
  sockets = []
})

const stepNameBrand = (name: string): StepName => name as StepName

const waitForMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!canRun)('startStatusLoop against a real tmux pane', () => {
  it('renders a step:start event into the status pane within a short capture window', async () => {
    const tmux = new RealTmuxService({ processService: new BunProcessService() })
    const socket = newSocket('start')

    await tmux.createSession({ socket, session: 'main', width: 200, height: 50 })
    const pane = await tmux.splitPane({
      socket,
      session: 'main',
      orientation: 'h',
      percent: 30,
      command: 'cat',
    })

    const loop = startStatusLoop({
      tmux,
      socket,
      target: paneId(pane),
      clock: new BunClock(),
      tty: true,
    })

    try {
      loop.onStepEvent({
        type: 'step:start',
        stepName: stepNameBrand('brainstorm'),
        mode: 'interactive',
      })

      // Give tmux a moment to process the keys.
      await waitForMs(100)

      const captured = await tmux.capturePane({ socket, target: paneId(pane) })
      expect(captured).toContain('brainstorm')
    } finally {
      loop.stop()
    }
  })
})
