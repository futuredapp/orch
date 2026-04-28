// Gated real tmux tests. Each test creates its own socket and kills the
// server in `afterEach` — tests run in parallel by bun test, so separate
// sockets prevent cross-contamination.

import { afterEach, describe, expect, it } from 'bun:test'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { BunProcessService } from '../../../../src/services/process/index.ts'
import {
  initOrchSession,
  paneId,
  RealTmuxService,
  type SocketName,
  socketName,
  TmuxCommandError,
} from '../../../../src/services/tmux/index.ts'
import { path } from '../../../../src/services/types.ts'

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

  // Regression: an interactive run that ends with the agent exiting
  // cleanly (Claude Code's "Ctrl+C twice" gesture returns exit 0) used to
  // leave runInteractive() hung in waitFor for the full 1-hour cap. The
  // sibling test above only covers exit≠0 — `pane-died` only fires when
  // remain-on-exit keeps the pane visible, so under remain-on-exit=failed
  // a clean exit closed the pane silently and the wait-for channel was
  // never signaled. This pins the contract that the hook fires for ANY
  // exit code, so a regression to a value that gates by exit code (or any
  // other change that drops the pane-died signal on success) fails fast.
  it('signals the wait-for channel even when the pane process exits 0', async () => {
    const tmux = new RealTmuxService({ processService: new BunProcessService() })
    const socket = newSocket('panedied-clean')

    await initOrchSession(tmux, {
      socket,
      session: 'main',
      width: 200,
      height: 50,
      paneDiedCommand: `run-shell "tmux -L ${socket} wait-for -S pane-exit-#{hook_pane}"`,
    })

    const pane = await tmux.splitPane({
      socket,
      session: 'main',
      orientation: 'h',
      percent: 30,
      command: 'sh -c "exit 0"',
    })

    await tmux.waitFor({
      socket,
      channel: `pane-exit-${pane}`,
      timeoutMs: 5_000,
    })
  })

  // Regression: tmux servers used to launch with a pinned 3-key env
  // (PATH/HOME/LANG), so the user's `ANTHROPIC_API_KEY`, OAuth keychain
  // bootstrap vars, and `NODE_OPTIONS` never reached pane processes — the
  // interactive Claude pane would prompt "Please run /login" even when the
  // outer shell was logged in. Under passthrough, the tmux server inherits
  // the orch process's full env, so a non-allowlist key reaches a child
  // started with `respawn-pane`. The `assertNoNestedTmux` guard (in
  // two-pane host) is what keeps `TMUX` / `TMUX_PANE` passthrough safe —
  // do not weaken it under the new contract.
  it('inherits the orch process env so non-allowlist keys reach pane processes', async () => {
    const sentinel = `ORCH_PASSTHROUGH_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
    process.env.ORCH_TEST_SENTINEL = sentinel
    try {
      const tmux = new RealTmuxService({ processService: new BunProcessService() })
      const socket = newSocket('passthrough')

      await tmux.createSession({ socket, session: 'main', width: 200, height: 50 })
      // `printenv ORCH_TEST_SENTINEL > /tmp/<sentinel>` lets the child write
      // its env-visible value to a deterministic path; we read it back below.
      const outFile = `/tmp/orch-passthrough-${Date.now()}-${Math.floor(Math.random() * 1e6)}.txt`
      const pane = await tmux.splitPane({
        socket,
        session: 'main',
        orientation: 'h',
        percent: 30,
        command: `sh -c "printenv ORCH_TEST_SENTINEL > ${outFile}; sleep 0.5"`,
      })
      expect(pane).toMatch(/^%\d+$/)

      // Wait for the printenv child to flush the file.
      await new Promise((r) => setTimeout(r, 600))
      const written = await Bun.file(outFile).text()
      expect(written.trim()).toBe(sentinel)
    } finally {
      delete process.env.ORCH_TEST_SENTINEL
    }
  })

  // Regression: tmux-host's `runInteractive` used to drop `spawn.cwd` on the
  // floor — every tmux subprocess in RealTmuxService runs with `cwd: '/'`, so
  // panes were created at `/` and respawn-pane (without `-c`) kept that.
  // Claude's `Bash(pwd)` returned `/` and `Write(./riddle.txt)` blew up with
  // `EROFS: read-only file system, open '/riddle.txt'`. This test pins the
  // contract: respawn-pane with `-c <dir>` puts the replacement process at
  // `<dir>`, observable via tmux's own `#{pane_current_path}`.
  it('respawn-pane -c sets the pane current_path so runners see the project cwd', async () => {
    const tmux = new RealTmuxService({ processService: new BunProcessService() })
    const socket = newSocket('respawn-cwd')

    // Resolve symlinks once: macOS reports `/private/tmp` for `/tmp`. tmux's
    // `#{pane_current_path}` follows the OS, so we compare resolved paths.
    const dir = await realpath(tmpdir())

    await tmux.createSession({ socket, session: 'main', width: 200, height: 50 })
    const pane = await tmux.splitPane({
      socket,
      session: 'main',
      orientation: 'h',
      percent: 30,
      command: 'cat',
    })

    await tmux.respawnPane({
      socket,
      target: pane,
      argv: ['cat'],
      killRunning: true,
      cwd: path(dir),
    })

    // tmux updates `#{pane_current_path}` from the pane's tty cwd; give the
    // shell a beat to settle after respawn.
    await new Promise((r) => setTimeout(r, 200))
    const observed = await tmux.displayMessage({
      socket,
      target: pane,
      format: '#{pane_current_path}',
    })
    const observedReal = await realpath(observed)
    expect(observedReal).toBe(dir)
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
