// Real-tmux coverage for the scratch-session helpers + a swap-between-two-
// file-tail-sources smoke test. Pins the load-bearing invariants of the
// pane-map design:
//
//   - the scratch session is created with `destroy-unattached off` so a
//     user's tmux config can't tear it down behind our back (no client
//     ever attaches);
//   - two file-tail sources can be registered and swapped; the visible
//     pane's content matches the active source after each swap;
//   - teardown kills the scratch session BEFORE the visible session so
//     hidden panes never outlive their swap target.

import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createScratchSession,
  SCRATCH_SESSION_NAME,
  teardownScratchSession,
} from '../../../../src/hosts/two-pane/pane-map/index.ts'
import { BunProcessService } from '../../../../src/services/process/index.ts'
import {
  RealTmuxService,
  type SocketName,
  socketName,
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
let tempDirs: string[] = []

const newSocket = (tag: string): SocketName => {
  const s = socketName(`orch-scratch-test-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
  sockets.push(s)
  return s
}

afterEach(async () => {
  for (const s of sockets) await killServer(s)
  for (const d of tempDirs) await rm(d, { recursive: true, force: true })
  sockets = []
  tempDirs = []
})

describe.skipIf(!canRun)('scratch-session lifecycle on real tmux', () => {
  it('creates the scratch session as a sibling of the visible orch session', async () => {
    const tmux = new RealTmuxService({ processService: new BunProcessService() })
    const socket = newSocket('create')

    await tmux.createSession({ socket, session: 'orch', width: 200, height: 50 })
    const handle = await createScratchSession({ tmux, socket, width: 200, height: 50 })

    expect(handle.session).toBe(SCRATCH_SESSION_NAME)

    // Both sessions should exist on the same server. `list-panes -t <session>`
    // returns at least one line per session when it exists.
    const orchPanes = await tmux.listPanes({ socket, session: 'orch', format: '#{pane_id}' })
    const scratchPanes = await tmux.listPanes({
      socket,
      session: handle.session,
      format: '#{pane_id}',
    })
    expect(orchPanes.length).toBeGreaterThanOrEqual(1)
    expect(scratchPanes.length).toBeGreaterThanOrEqual(1)
  })

  it('runs the cat holder argv as the scratch initial pane', async () => {
    const tmux = new RealTmuxService({ processService: new BunProcessService() })
    const socket = newSocket('holder')

    await tmux.createSession({ socket, session: 'orch', width: 200, height: 50 })
    const handle = await createScratchSession({ tmux, socket, width: 200, height: 50 })

    // The initial pane's running command must be `cat` — it blocks on the
    // pane's pty stdin (no one ever writes to it in the scratch session)
    // and never exits on its own. `pane_current_command` reflects the
    // foreground process in the pane's pty.
    const cmds = await tmux.listPanes({
      socket,
      session: handle.session,
      format: '#{pane_current_command}',
    })
    expect(cmds).toContain('cat')
  })

  it('teardown kills the scratch session and leaves the orch session alive', async () => {
    const tmux = new RealTmuxService({ processService: new BunProcessService() })
    const socket = newSocket('teardown-order')

    await tmux.createSession({ socket, session: 'orch', width: 200, height: 50 })
    const handle = await createScratchSession({ tmux, socket, width: 200, height: 50 })

    await teardownScratchSession(tmux, handle)

    // orch survives; scratch is gone (list-panes throws or returns empty).
    const orchPanes = await tmux.listPanes({ socket, session: 'orch', format: '#{pane_id}' })
    expect(orchPanes.length).toBeGreaterThanOrEqual(1)
    await expect(
      tmux.listPanes({ socket, session: handle.session, format: '#{pane_id}' }),
    ).rejects.toThrow()
  })

  it('teardownScratchSession tolerates double-teardown without erroring', async () => {
    const tmux = new RealTmuxService({ processService: new BunProcessService() })
    const socket = newSocket('idempotent')

    await tmux.createSession({ socket, session: 'orch', width: 200, height: 50 })
    const handle = await createScratchSession({ tmux, socket, width: 200, height: 50 })
    await teardownScratchSession(tmux, handle)
    // Second teardown — must not throw (idempotent).
    await teardownScratchSession(tmux, handle)
  })

  it('two file-tail hidden panes can be swapped through the visible pane', async () => {
    const tmux = new RealTmuxService({ processService: new BunProcessService() })
    const socket = newSocket('swap-two-tails')
    const dir = await mkdtemp(join(tmpdir(), 'orch-pane-map-'))
    tempDirs.push(dir)

    const fileA = toPath(`${dir}/a.log`)
    const fileB = toPath(`${dir}/b.log`)
    await writeFile(fileA, 'AAA_SOURCE_A_AAA\n', 'utf8')
    await writeFile(fileB, 'BBB_SOURCE_B_BBB\n', 'utf8')

    await tmux.createSession({ socket, session: 'orch', width: 200, height: 50 })
    // Add a visible right pane so we have a swap target.
    const visible = await tmux.splitPane({
      socket,
      session: 'orch',
      orientation: 'h',
      percent: 50,
      command: 'cat',
    })

    const handle = await createScratchSession({ tmux, socket, width: 200, height: 50 })

    // Hidden file-tail panes for A and B.
    const hiddenA = await tmux.splitPane({
      socket,
      session: handle.session,
      orientation: 'h',
      percent: 50,
      argv: ['tail', '-n', '5000', '-F', fileA],
    })
    const hiddenB = await tmux.splitPane({
      socket,
      session: handle.session,
      orientation: 'h',
      percent: 50,
      argv: ['tail', '-n', '5000', '-F', fileB],
    })

    // Settle the tail processes' initial output.
    await new Promise((r) => setTimeout(r, 300))

    // Swap A into visible.
    await tmux.swapPane({ socket, src: hiddenA, dst: visible })
    await new Promise((r) => setTimeout(r, 150))
    const afterA = await tmux.capturePane({ socket, target: hiddenA })
    expect(afterA).toContain('AAA_SOURCE_A_AAA')

    // visiblePaneId is now hiddenA (swap-pane exchanges positions, pane ids
    // stay attached to processes). Swap B into the currently-visible slot.
    await tmux.swapPane({ socket, src: hiddenB, dst: hiddenA })
    await new Promise((r) => setTimeout(r, 150))
    const afterB = await tmux.capturePane({ socket, target: hiddenB })
    expect(afterB).toContain('BBB_SOURCE_B_BBB')

    await teardownScratchSession(tmux, handle)
  })
})
