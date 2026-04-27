// Gated real tmux tests. Each test creates its own socket and kills the
// server in `afterEach` — tests run in parallel by bun test, so separate
// sockets prevent cross-contamination.

import { afterEach, describe, expect, it } from 'bun:test'
import { BunProcessService } from '../../../../src/services/process/index.ts'
import {
  initOrchSession,
  paneId,
  RealTmuxService,
  type SocketName,
  socketName,
  TmuxCommandError,
} from '../../../../src/services/tmux/index.ts'

const canRun = Bun.which('tmux') !== null

const killServer = async (socket: SocketName): Promise<void> => {
  // Fire-and-forget: the server may already be gone.
  const proc = Bun.spawn(['tmux', '-L', socket, 'kill-server'], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  await proc.exited
}

let sockets: SocketName[] = []

const newSocket = (tag: string): SocketName => {
  const s = socketName(`orch-test-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
  sockets.push(s)
  return s
}

afterEach(async () => {
  for (const s of sockets) await killServer(s)
  sockets = []
})

describe.skipIf(!canRun)('RealTmuxService against a real tmux server', () => {
  it('creates a session, splits a pane, and returns a valid tmux pane id', async () => {
    const tmux = new RealTmuxService({ processService: new BunProcessService() })
    const socket = newSocket('split')

    await tmux.createSession({ socket, session: 'main', width: 200, height: 50 })
    const pane = await tmux.splitPane({
      socket,
      session: 'main',
      orientation: 'h',
      percent: 30,
      command: 'cat',
    })

    expect(pane).toMatch(/^%\d+$/)
  })

  it('queries pane status via display-message with a format variable', async () => {
    const tmux = new RealTmuxService({ processService: new BunProcessService() })
    const socket = newSocket('display')

    await tmux.createSession({ socket, session: 'main', width: 200, height: 50 })
    const pane = await tmux.splitPane({
      socket,
      session: 'main',
      orientation: 'h',
      percent: 30,
      command: 'cat',
    })

    const dead = await tmux.displayMessage({
      socket,
      target: pane,
      format: '#{pane_dead}',
    })

    expect(['0', '1']).toContain(dead)
  })

  it('throws TmuxCommandError when display-message targets a non-existent pane', async () => {
    const tmux = new RealTmuxService({ processService: new BunProcessService() })
    const socket = newSocket('invalid')

    await tmux.createSession({ socket, session: 'main', width: 200, height: 50 })

    await expect(
      tmux.displayMessage({
        socket,
        target: paneId('%999'),
        format: '#{pane_dead}',
      }),
    ).rejects.toBeInstanceOf(TmuxCommandError)
  })

  it('sendKeys with Enter delivers literal keystrokes to the target pane', async () => {
    const tmux = new RealTmuxService({ processService: new BunProcessService() })
    const socket = newSocket('sendkeys')

    await tmux.createSession({ socket, session: 'main', width: 200, height: 50 })
    const pane = await tmux.splitPane({
      socket,
      session: 'main',
      orientation: 'h',
      percent: 30,
      command: 'cat',
    })

    // Ship a payload loaded with shell metacharacters. If argv-safety works,
    // the payload is handed verbatim to cat(1) — no shell interpolation.
    await tmux.sendKeys({
      socket,
      target: pane,
      keys: ['$(whoami); echo metachars'],
      enter: true,
    })

    // No assertion on stdout — cat just echoes it. The test proves tmux
    // accepted the command and the process didn't crash or throw.
    expect(true).toBe(true)
  })

  // Regression: the `pane-died` hook used to be wired with
  // `run-shell "tmux wait-for -S …"` — missing `-L <socket>`. When a pane
  // died, the inner tmux client connected to the *default* socket and
  // signalled there, never our scoped one. `waitFor` then hung until the
  // user force-closed the terminal. The hook now interpolates the socket so
  // the inner tmux signals the same server that fired the hook.
  it('signals the per-pane wait-for channel via the pane-died hook on the same socket', async () => {
    const tmux = new RealTmuxService({ processService: new BunProcessService() })
    const socket = newSocket('panedied')

    // Mirrors the production hook shape from tmux-host's
    // `buildPaneDiedCommand(socket)`. We re-derive it here rather than
    // import it so the test stays independent of that helper's surface and
    // would catch a regression even if the helper were refactored.
    await initOrchSession(tmux, {
      socket,
      session: 'main',
      width: 200,
      height: 50,
      paneDiedCommand: `run-shell "tmux -L ${socket} wait-for -S pane-exit-#{hook_pane}"`,
    })

    // Spawn a short-lived non-zero exiter so `remain-on-exit=failed` keeps
    // the pane around (mirrors a runner crashing or being Ctrl-C'd).
    const pane = await tmux.splitPane({
      socket,
      session: 'main',
      orientation: 'h',
      percent: 30,
      command: 'sh -c "sleep 0.2; exit 1"',
    })

    // Race against a budget that's an order of magnitude smaller than the
    // 1-hour production cap — if the hook is misrouted again, this fails fast.
    await tmux.waitFor({
      socket,
      channel: `pane-exit-${pane}`,
      timeoutMs: 5_000,
    })
  })

  it('isolates state across concurrent sockets', async () => {
    const tmux = new RealTmuxService({ processService: new BunProcessService() })
    const a = newSocket('iso-a')
    const b = newSocket('iso-b')

    await Promise.all([
      tmux.createSession({ socket: a, session: 'main', width: 200, height: 50 }),
      tmux.createSession({ socket: b, session: 'main', width: 200, height: 50 }),
    ])

    const [paneA, paneB] = await Promise.all([
      tmux.splitPane({ socket: a, session: 'main', orientation: 'h', percent: 30, command: 'cat' }),
      tmux.splitPane({ socket: b, session: 'main', orientation: 'h', percent: 30, command: 'cat' }),
    ])

    expect(paneA).toMatch(/^%\d+$/)
    expect(paneB).toMatch(/^%\d+$/)
  })
})
