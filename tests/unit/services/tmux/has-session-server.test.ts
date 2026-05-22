// Unit coverage for `TmuxService.hasSession` / `hasServer`. Both methods are
// exit-code probes that flatten "no session" / "no server running" stderr
// into a boolean, while unexpected failures still throw. The tests script
// `FakeProcessService` for the wrapped `tmux` argv and exercise the four
// outcomes documented on each method.

import { describe, expect, it } from 'bun:test'
import { FakeProcessService } from '../../../../src/services/process/fake-process-service.ts'
import {
  FakeTmuxService,
  RealTmuxService,
  socketName,
  TmuxCommandError,
} from '../../../../src/services/tmux/index.ts'

const SOCKET = socketName('orch-test')

describe('RealTmuxService.hasSession', () => {
  it('returns true when tmux has-session exits 0', async () => {
    const procs = new FakeProcessService()
    procs.when(['tmux', '-L', SOCKET, 'has-session', '-t', '=orch']).respondWith({ exitCode: 0 })
    const tmux = new RealTmuxService({ processService: procs })

    const exists = await tmux.hasSession({ socket: SOCKET, session: 'orch' })

    expect(exists).toBe(true)
  })

  it('returns false when tmux reports a missing session on a live server', async () => {
    const procs = new FakeProcessService()
    procs
      .when(['tmux', '-L', SOCKET, 'has-session', '-t', '=orch'])
      .respondWith({ exitCode: 1, stderr: [`can't find session: orch`] })
    const tmux = new RealTmuxService({ processService: procs })

    const exists = await tmux.hasSession({ socket: SOCKET, session: 'orch' })

    expect(exists).toBe(false)
  })

  it('returns false when the tmux server itself is down', async () => {
    const procs = new FakeProcessService()
    procs
      .when(['tmux', '-L', SOCKET, 'has-session', '-t', '=orch'])
      .respondWith({ exitCode: 1, stderr: ['no server running on /tmp/tmux/orch-test'] })
    const tmux = new RealTmuxService({ processService: procs })

    const exists = await tmux.hasSession({ socket: SOCKET, session: 'orch' })

    expect(exists).toBe(false)
  })

  it('returns false when tmux exits 1 with empty stderr (silent missing-session)', async () => {
    const procs = new FakeProcessService()
    procs.when(['tmux', '-L', SOCKET, 'has-session', '-t', '=orch']).respondWith({ exitCode: 1 })
    const tmux = new RealTmuxService({ processService: procs })

    const exists = await tmux.hasSession({ socket: SOCKET, session: 'orch' })

    expect(exists).toBe(false)
  })

  it('throws TmuxCommandError on unexpected tmux failures', async () => {
    const procs = new FakeProcessService()
    procs
      .when(['tmux', '-L', SOCKET, 'has-session', '-t', '=orch'])
      .respondWith({ exitCode: 127, stderr: ['command not found: tmux'] })
    const tmux = new RealTmuxService({ processService: procs })

    await expect(tmux.hasSession({ socket: SOCKET, session: 'orch' })).rejects.toBeInstanceOf(
      TmuxCommandError,
    )
  })
})

describe('RealTmuxService.hasServer', () => {
  it('returns true when tmux list-sessions exits 0', async () => {
    const procs = new FakeProcessService()
    procs
      .when(['tmux', '-L', SOCKET, 'list-sessions'])
      .respondWith({ exitCode: 0, stdout: ['orch: 1 windows (created Wed)'] })
    const tmux = new RealTmuxService({ processService: procs })

    const reachable = await tmux.hasServer({ socket: SOCKET })

    expect(reachable).toBe(true)
  })

  it('returns false when tmux reports "no server running"', async () => {
    const procs = new FakeProcessService()
    procs
      .when(['tmux', '-L', SOCKET, 'list-sessions'])
      .respondWith({ exitCode: 1, stderr: ['no server running on /tmp/tmux/orch-test'] })
    const tmux = new RealTmuxService({ processService: procs })

    const reachable = await tmux.hasServer({ socket: SOCKET })

    expect(reachable).toBe(false)
  })

  it('throws TmuxCommandError on unexpected stderr', async () => {
    const procs = new FakeProcessService()
    procs
      .when(['tmux', '-L', SOCKET, 'list-sessions'])
      .respondWith({ exitCode: 2, stderr: ['some other tmux error'] })
    const tmux = new RealTmuxService({ processService: procs })

    await expect(tmux.hasServer({ socket: SOCKET })).rejects.toBeInstanceOf(TmuxCommandError)
  })
})

describe('FakeTmuxService.hasSession / hasServer', () => {
  it('reports presence after createSession on the matching socket', async () => {
    const tmux = new FakeTmuxService()

    await tmux.createSession({ socket: SOCKET, session: 'orch', width: 80, height: 24 })

    expect(await tmux.hasSession({ socket: SOCKET, session: 'orch' })).toBe(true)
    expect(await tmux.hasServer({ socket: SOCKET })).toBe(true)
  })

  it('returns false for unknown sockets even after a session was created elsewhere', async () => {
    const tmux = new FakeTmuxService()
    const other = socketName('orch-other')
    await tmux.createSession({ socket: other, session: 'orch', width: 80, height: 24 })

    expect(await tmux.hasSession({ socket: SOCKET, session: 'orch' })).toBe(false)
    expect(await tmux.hasServer({ socket: SOCKET })).toBe(false)
  })

  it('reflects killSession by reporting the session as gone', async () => {
    const tmux = new FakeTmuxService()
    await tmux.createSession({ socket: SOCKET, session: 'orch', width: 80, height: 24 })

    await tmux.killSession({ socket: SOCKET, session: 'orch' })

    expect(await tmux.hasSession({ socket: SOCKET, session: 'orch' })).toBe(false)
    // Once every session is gone, the server-side probe reports down too — the
    // fake's session table is the only liveness signal it has.
    expect(await tmux.hasServer({ socket: SOCKET })).toBe(false)
  })

  it('honors setSessions for scripted server-up / server-down setups', async () => {
    const tmux = new FakeTmuxService()

    tmux.setSessions(SOCKET, ['orch', 'helper'])
    expect(await tmux.hasSession({ socket: SOCKET, session: 'orch' })).toBe(true)
    expect(await tmux.hasSession({ socket: SOCKET, session: 'helper' })).toBe(true)
    expect(await tmux.hasServer({ socket: SOCKET })).toBe(true)

    tmux.setSessions(SOCKET, undefined)
    expect(await tmux.hasSession({ socket: SOCKET, session: 'orch' })).toBe(false)
    expect(await tmux.hasServer({ socket: SOCKET })).toBe(false)
  })
})
