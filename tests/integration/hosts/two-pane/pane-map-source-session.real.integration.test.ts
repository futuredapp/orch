// Real-tmux coverage for the per-source session helpers + a swap-between-two-
// file-tail-sources smoke test. Pins the load-bearing invariants of the
// per-source pane-map design (KTD2/KTD3 in
// docs/plans/2026-05-22-001-refactor-per-source-tmux-sessions-plan.md):
//
//   - one tmux session per source on the same socket as `orch`;
//   - `createSession -P -F '#{pane_id}'` returns the initial pane id and
//     `listPanes(...)` confirms the session owns exactly that pane;
//   - sanitization round-trips (a key with `:` / `.` produces a session name
//     present on the socket);
//   - the `placeholder` source uses the `cat` holder as its initial pane;
//   - file-tail sources can be swapped through the visible pane (cross-session
//     `swap-pane`, because tmux pane ids are server-wide);
//   - `teardownSourceSession` is idempotent and leaves the `orch` session
//     reachable.

import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createSourceSession,
  SOURCE_HOLDER_ARGV,
  sanitizeSessionName,
  teardownSourceSession,
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
  const s = socketName(`orch-src-test-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
  sockets.push(s)
  return s
}

afterEach(async () => {
  for (const s of sockets) await killServer(s)
  for (const d of tempDirs) await rm(d, { recursive: true, force: true })
  sockets = []
  tempDirs = []
})

describe.skipIf(!canRun)('per-source session lifecycle on real tmux', () => {
  it('creates a per-source session as a sibling of the visible orch session, on the same socket', async () => {
    const tmux = new RealTmuxService({ processService: new BunProcessService() })
    const socket = newSocket('create')

    await tmux.createSession({ socket, session: 'orch', width: 200, height: 50 })
    const sessionName = sanitizeSessionName('placeholder')
    const handle = await createSourceSession({
      tmux,
      socket,
      sessionName,
      width: 200,
      height: 50,
      command: SOURCE_HOLDER_ARGV,
    })

    expect(handle.session).toBe(sessionName)
    expect(handle.session).toBe('orch-src-placeholder')

    // Both sessions exist on the same server. listPanes returns each session's
    // initial pane; the per-source session's initial pane id matches the one
    // createSession returned.
    const orchPanes = await tmux.listPanes({ socket, session: 'orch', format: '#{pane_id}' })
    const sourcePanes = await tmux.listPanes({
      socket,
      session: handle.session,
      format: '#{pane_id}',
    })
    expect(orchPanes.length).toBeGreaterThanOrEqual(1)
    expect(sourcePanes).toContain(handle.paneId)
  })

  it('runs the cat holder argv as the placeholder session initial pane', async () => {
    const tmux = new RealTmuxService({ processService: new BunProcessService() })
    const socket = newSocket('holder')

    await tmux.createSession({ socket, session: 'orch', width: 200, height: 50 })
    const handle = await createSourceSession({
      tmux,
      socket,
      sessionName: sanitizeSessionName('placeholder'),
      width: 200,
      height: 50,
      command: SOURCE_HOLDER_ARGV,
    })

    // The placeholder session's initial pane must be `cat` — it blocks on the
    // pane's pty stdin (no one ever writes to it) and never exits on its own.
    // Use `pane_start_command` rather than `pane_current_command` to avoid a
    // race: tmux launches the process async and `pane_current_command` can
    // briefly show the inherited login shell before exec resolves.
    const cmds = await tmux.listPanes({
      socket,
      session: handle.session,
      format: '#{pane_start_command}',
    })
    expect(cmds).toContain('cat')
  })

  it('runs the file-tail argv as the initial pane for a non-placeholder source', async () => {
    const tmux = new RealTmuxService({ processService: new BunProcessService() })
    const socket = newSocket('file-tail')
    const dir = await mkdtemp(join(tmpdir(), 'orch-src-tail-'))
    tempDirs.push(dir)
    const teePath = toPath(`${dir}/transcript.ansi`)
    await writeFile(teePath, 'INITIAL_BYTES\n', 'utf8')

    await tmux.createSession({ socket, session: 'orch', width: 200, height: 50 })
    const handle = await createSourceSession({
      tmux,
      socket,
      sessionName: sanitizeSessionName('live:command:assign-roles-1'),
      width: 200,
      height: 50,
      command: ['tail', '-n', '5000', '-F', teePath],
    })

    // The pane runs `tail` directly — there is no separate `cat` holder for
    // non-placeholder sources. Same `pane_start_command` trick as the
    // placeholder cell above to dodge the launch-time race.
    // `pane_start_command` returns the full command line (argv joined by
    // spaces), so substring-match for the `tail` binary.
    const cmds = await tmux.listPanes({
      socket,
      session: handle.session,
      format: '#{pane_start_command}',
    })
    expect(cmds.some((c) => c.startsWith('tail'))).toBe(true)
  })

  it('rounds the sanitizer output trip — a colon/dot key produces a session name actually present on the socket', async () => {
    const tmux = new RealTmuxService({ processService: new BunProcessService() })
    const socket = newSocket('sanitize-roundtrip')

    await tmux.createSession({ socket, session: 'orch', width: 200, height: 50 })

    const key = 'replay:step.with.dots'
    const sessionName = sanitizeSessionName(key)
    expect(sessionName).toBe('orch-src-replay-step-with-dots')

    const handle = await createSourceSession({
      tmux,
      socket,
      sessionName,
      width: 200,
      height: 50,
      command: SOURCE_HOLDER_ARGV,
    })

    // `hasSession` confirms the sanitizer's output matches what tmux saw.
    const exists = await tmux.hasSession({ socket, session: handle.session })
    expect(exists).toBe(true)
  })

  it('teardownSourceSession kills the per-source session and leaves orch alive', async () => {
    const tmux = new RealTmuxService({ processService: new BunProcessService() })
    const socket = newSocket('teardown-order')

    await tmux.createSession({ socket, session: 'orch', width: 200, height: 50 })
    const handle = await createSourceSession({
      tmux,
      socket,
      sessionName: sanitizeSessionName('placeholder'),
      width: 200,
      height: 50,
      command: SOURCE_HOLDER_ARGV,
    })

    await teardownSourceSession(tmux, handle)

    // orch survives; the per-source session is gone.
    const orchPanes = await tmux.listPanes({ socket, session: 'orch', format: '#{pane_id}' })
    expect(orchPanes.length).toBeGreaterThanOrEqual(1)
    expect(await tmux.hasSession({ socket, session: handle.session })).toBe(false)
    expect(await tmux.hasSession({ socket, session: 'orch' })).toBe(true)
  })

  it('teardownSourceSession tolerates double-teardown without erroring', async () => {
    const tmux = new RealTmuxService({ processService: new BunProcessService() })
    const socket = newSocket('idempotent')

    await tmux.createSession({ socket, session: 'orch', width: 200, height: 50 })
    const handle = await createSourceSession({
      tmux,
      socket,
      sessionName: sanitizeSessionName('placeholder'),
      width: 200,
      height: 50,
      command: SOURCE_HOLDER_ARGV,
    })
    await teardownSourceSession(tmux, handle)
    // Second teardown — must not throw (idempotent).
    await teardownSourceSession(tmux, handle)
  })

  it('two file-tail per-source sessions can be swapped through the visible pane (cross-session swap-pane)', async () => {
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

    const handleA = await createSourceSession({
      tmux,
      socket,
      sessionName: sanitizeSessionName('live:source-a'),
      width: 200,
      height: 50,
      command: ['tail', '-n', '5000', '-F', fileA],
    })
    const handleB = await createSourceSession({
      tmux,
      socket,
      sessionName: sanitizeSessionName('live:source-b'),
      width: 200,
      height: 50,
      command: ['tail', '-n', '5000', '-F', fileB],
    })

    // Settle the tail processes' initial output.
    await new Promise((r) => setTimeout(r, 300))

    // Swap A into visible. Cross-session: src lives in handleA's session, dst
    // lives in `orch`; pane ids are server-wide so this works.
    await tmux.swapPane({ socket, src: handleA.paneId, dst: visible })
    await new Promise((r) => setTimeout(r, 150))
    const afterA = await tmux.capturePane({ socket, target: handleA.paneId })
    expect(afterA).toContain('AAA_SOURCE_A_AAA')

    // visiblePaneId is now handleA.paneId (swap-pane exchanges positions;
    // pane ids stay attached to their processes). Swap B into the currently-
    // visible slot.
    await tmux.swapPane({ socket, src: handleB.paneId, dst: handleA.paneId })
    await new Promise((r) => setTimeout(r, 150))
    const afterB = await tmux.capturePane({ socket, target: handleB.paneId })
    expect(afterB).toContain('BBB_SOURCE_B_BBB')

    await teardownSourceSession(tmux, handleA)
    await teardownSourceSession(tmux, handleB)
  })
})
