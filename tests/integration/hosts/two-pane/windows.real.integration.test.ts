// Gated real-tmux test — verifies the create / select / kill window dance
// works against a live tmux server (not a fake recorder). Each test creates
// its own socket and kills the server in `afterEach`.

import { afterEach, describe, expect, it } from 'bun:test'
import { tmpdir } from 'node:os'
import { BunProcessService } from '../../../../src/services/process/index.ts'
import {
  RealTmuxService,
  type SocketName,
  socketName,
  windowId,
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

let sockets: SocketName[] = []

const newSocket = (tag: string): SocketName => {
  const s = socketName(`orch-test-win-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
  sockets.push(s)
  return s
}

afterEach(async () => {
  for (const s of sockets) await killServer(s)
  sockets = []
})

const listWindowIds = async (socket: SocketName, session: string): Promise<string[]> => {
  const proc = Bun.spawn(
    ['tmux', '-L', socket, 'list-windows', '-t', session, '-F', '#{window_id}'],
    { stdout: 'pipe', stderr: 'ignore' },
  )
  const stdout = await new Response(proc.stdout).text()
  await proc.exited
  return stdout.split('\n').filter((l) => l.trim().length > 0)
}

describe.skipIf(!canRun)('RealTmuxService window lifecycle on real tmux', () => {
  // Note: detach + reattach preserving both windows is documented in the plan
  // as a desirable property; scripting it here would require a pty harness
  // beyond what this test owns. Cover the create / select / kill happy path
  // here and TODO the detach/reattach scenario for the e2e harness.
  it('creates a second window via newWindow, leaving list-windows showing two windows', async () => {
    const tmux = new RealTmuxService({ processService: new BunProcessService() })
    const socket = newSocket('create')

    await tmux.createSession({ socket, session: 'main', width: 200, height: 50 })

    const before = await listWindowIds(socket, 'main')
    expect(before).toHaveLength(1)

    const result = await tmux.newWindow({
      socket,
      session: 'main',
      name: 'replay',
      cwd: toPath(tmpdir()),
    })

    expect(result.windowId).toMatch(/^@\d+$/)
    expect(result.paneId).toMatch(/^%\d+$/)

    const after = await listWindowIds(socket, 'main')
    expect(after).toHaveLength(2)
    expect(after).toContain(result.windowId)
  })

  it('selectWindow back to window 0, then killWindow on window 1, leaves only one window', async () => {
    const tmux = new RealTmuxService({ processService: new BunProcessService() })
    const socket = newSocket('select-kill')

    await tmux.createSession({ socket, session: 'main', width: 200, height: 50 })
    const ids = await listWindowIds(socket, 'main')
    const firstId = ids[0]
    if (firstId === undefined) throw new Error('expected initial window id')

    const replay = await tmux.newWindow({
      socket,
      session: 'main',
      name: 'replay',
      cwd: toPath(tmpdir()),
    })

    // Switch to the original window via the smart-constructor branded id.
    await tmux.selectWindow({ socket, target: windowId(firstId) })
    await tmux.killWindow({ socket, target: replay.windowId })

    const after = await listWindowIds(socket, 'main')
    expect(after).toHaveLength(1)
    expect(after).toContain(firstId)
    expect(after).not.toContain(replay.windowId)
  })

  it('killWindow tolerates a missing window id (idempotent teardown)', async () => {
    const tmux = new RealTmuxService({ processService: new BunProcessService() })
    const socket = newSocket('idempotent')

    await tmux.createSession({ socket, session: 'main', width: 200, height: 50 })
    const replay = await tmux.newWindow({
      socket,
      session: 'main',
      name: 'replay',
      cwd: toPath(tmpdir()),
    })

    await tmux.killWindow({ socket, target: replay.windowId })
    // Second kill against the now-gone window must NOT throw — the contract
    // says teardown is idempotent.
    await tmux.killWindow({ socket, target: replay.windowId })
  })
})
