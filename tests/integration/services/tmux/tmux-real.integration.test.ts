// Gated real tmux tests. Each test creates its own socket and kills the
// server in `afterEach` — tests run in parallel by bun test, so separate
// sockets prevent cross-contamination.

import { afterEach, describe, expect, it } from 'bun:test'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { BunFsService } from '../../../../src/services/fs/index.ts'
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
import { allocateSocketName } from '../../../helpers/real-tmux/index.ts'

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

// Reserved `orch-test-<pid>-<nonce>` socket (KTD-1) with the debug tag appended
// after the pid so the stale-socket preload can reap a crashed leak by liveness.
// The pre-pid `orch-test-<tag>` form had a non-numeric first segment and was
// unreapable by the new liveness sweep.
const newSocket = (tag: string): SocketName => {
  const s = socketName(`${allocateSocketName()}-${tag}`)
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

  it('createSession returns the initial pane id, and listPanes confirms it owns that pane', async () => {
    // U2 contract on the real adapter: `-P -F '#{pane_id}'` causes tmux to
    // print the new session's initial pane id; the parsed result must match
    // what `list-panes` reports for the same session.
    const tmux = new RealTmuxService({ processService: new BunProcessService() })
    const socket = newSocket('create-pane')

    const result = await tmux.createSession({
      socket,
      session: 'main',
      width: 200,
      height: 50,
      command: ['cat'],
    })

    expect(result.paneId).toMatch(/^%\d+$/)
    const ids = await tmux.listPanes({ socket, session: 'main', format: '#{pane_id}' })
    expect(ids).toContain(result.paneId)
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
    await initOrchSession(tmux, new BunFsService(), {
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

    await initOrchSession(tmux, new BunFsService(), {
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

  // ---------------------------------------------------------------------
  // swap-pane + argv-form split-window (U1 of the pane-map plan)
  // ---------------------------------------------------------------------

  it('swapPane exchanges the contents of two panes', async () => {
    const tmux = new RealTmuxService({ processService: new BunProcessService() })
    const socket = newSocket('swap-pane')

    // Spawn two panes that write distinct, observable text to their stdout.
    // We pick `printf` so the output is bounded (no shell prompt to compete).
    await tmux.createSession({ socket, session: 'main', width: 200, height: 50 })
    // Initial pane runs LEFT marker; the split pane runs RIGHT marker.
    const initialList = await tmux.listPanes({ socket, session: 'main', format: '#{pane_id}' })
    const initial = initialList[0]
    if (initial === undefined) throw new Error('expected initial pane')
    const leftPane = paneId(initial)

    // Respawn the initial pane to print a deterministic marker, then linger.
    await tmux.respawnPane({
      socket,
      target: leftPane,
      argv: ['sh', '-c', 'printf "LEFT_MARKER"; sleep 5'],
      killRunning: true,
    })

    const rightPane = await tmux.splitPane({
      socket,
      session: 'main',
      orientation: 'h',
      percent: 50,
      command: 'sh -c "printf RIGHT_MARKER; sleep 5"',
    })

    // Give both processes a moment to flush their markers.
    await new Promise((r) => setTimeout(r, 200))

    const preLeft = await tmux.capturePane({ socket, target: leftPane })
    const preRight = await tmux.capturePane({ socket, target: rightPane })
    expect(preLeft).toContain('LEFT_MARKER')
    expect(preRight).toContain('RIGHT_MARKER')

    await tmux.swapPane({ socket, src: leftPane, dst: rightPane })

    // After swap, the pane that holds LEFT_MARKER's stdout has moved positions
    // — but pane ids stay attached to their processes (capturePane is keyed by
    // pane id, so each id still returns its own process's output).
    const postLeft = await tmux.capturePane({ socket, target: leftPane })
    const postRight = await tmux.capturePane({ socket, target: rightPane })
    expect(postLeft).toContain('LEFT_MARKER')
    expect(postRight).toContain('RIGHT_MARKER')
  })

  it('swapPane works across sessions on the same socket', async () => {
    const tmux = new RealTmuxService({ processService: new BunProcessService() })
    const socket = newSocket('swap-cross-session')

    await tmux.createSession({ socket, session: 'main', width: 200, height: 50 })
    await tmux.createSession({ socket, session: 'other', width: 200, height: 50 })

    const mainPane = await tmux.splitPane({
      socket,
      session: 'main',
      orientation: 'h',
      percent: 50,
      command: 'cat',
    })
    const otherPane = await tmux.splitPane({
      socket,
      session: 'other',
      orientation: 'h',
      percent: 50,
      command: 'cat',
    })

    // The swap itself is the assertion — if cross-session swap is not
    // supported, swap-pane errors with a tmux error message.
    await tmux.swapPane({ socket, src: mainPane, dst: otherPane })

    // Both panes still exist after the swap (proxy: display-message succeeds).
    const liveMain = await tmux.displayMessage({
      socket,
      target: mainPane,
      format: '#{pane_dead}',
    })
    const liveOther = await tmux.displayMessage({
      socket,
      target: otherPane,
      format: '#{pane_dead}',
    })
    expect(liveMain).toBe('0')
    expect(liveOther).toBe('0')
  })

  it('swapPane throws TmuxCommandError when either pane id is invalid', async () => {
    const tmux = new RealTmuxService({ processService: new BunProcessService() })
    const socket = newSocket('swap-invalid')

    await tmux.createSession({ socket, session: 'main', width: 200, height: 50 })
    const pane = await tmux.splitPane({
      socket,
      session: 'main',
      orientation: 'h',
      percent: 30,
      command: 'cat',
    })

    await expect(tmux.swapPane({ socket, src: pane, dst: paneId('%999') })).rejects.toBeInstanceOf(
      TmuxCommandError,
    )
  })

  it('splitPane argv runs the given argv as the pane process', async () => {
    const tmux = new RealTmuxService({ processService: new BunProcessService() })
    const socket = newSocket('split-argv')

    await tmux.createSession({ socket, session: 'main', width: 200, height: 50 })
    const pane = await tmux.splitPane({
      socket,
      session: 'main',
      orientation: 'h',
      percent: 50,
      // `cat` lingers indefinitely on stdin — predictable for the assertion.
      argv: ['cat'],
    })

    // Give tmux a beat to attach the process.
    await new Promise((r) => setTimeout(r, 200))
    const cmd = await tmux.displayMessage({
      socket,
      target: pane,
      format: '#{pane_current_command}',
    })
    expect(cmd).toBe('cat')
  })

  it('splitPane argv with env exports the env to the pane process', async () => {
    const tmux = new RealTmuxService({ processService: new BunProcessService() })
    const socket = newSocket('split-argv-env')

    await tmux.createSession({ socket, session: 'main', width: 200, height: 50 })
    const outFile = `/tmp/orch-split-env-${Date.now()}-${Math.floor(Math.random() * 1e6)}.txt`
    await tmux.splitPane({
      socket,
      session: 'main',
      orientation: 'h',
      percent: 50,
      argv: ['sh', '-c', `printf "%s" "$FORCE_COLOR" > ${outFile}`],
      env: { FORCE_COLOR: '3' },
    })

    await new Promise((r) => setTimeout(r, 400))
    const written = await Bun.file(outFile).text()
    expect(written).toBe('3')
  })

  it('splitPane argv with cwd sets the pane current_path', async () => {
    const tmux = new RealTmuxService({ processService: new BunProcessService() })
    const socket = newSocket('split-argv-cwd')

    const dir = await realpath(tmpdir())
    await tmux.createSession({ socket, session: 'main', width: 200, height: 50 })
    const pane = await tmux.splitPane({
      socket,
      session: 'main',
      orientation: 'h',
      percent: 50,
      argv: ['cat'],
      cwd: path(dir),
    })

    await new Promise((r) => setTimeout(r, 200))
    const observed = await tmux.displayMessage({
      socket,
      target: pane,
      format: '#{pane_current_path}',
    })
    const observedReal = await realpath(observed)
    expect(observedReal).toBe(dir)
  })

  it('splitPane argv rejects env keys containing = or newline', async () => {
    const tmux = new RealTmuxService({ processService: new BunProcessService() })
    const socket = newSocket('split-argv-env-reject')

    await tmux.createSession({ socket, session: 'main', width: 200, height: 50 })

    await expect(
      tmux.splitPane({
        socket,
        session: 'main',
        orientation: 'h',
        percent: 50,
        argv: ['cat'],
        env: { 'BAD=KEY': 'value' },
      }),
    ).rejects.toThrow(/contains '=' or newline/)
  })

  it('splitPane argv rejects argv elements containing NUL', async () => {
    const tmux = new RealTmuxService({ processService: new BunProcessService() })
    const socket = newSocket('split-argv-nul')

    await tmux.createSession({ socket, session: 'main', width: 200, height: 50 })

    await expect(
      tmux.splitPane({
        socket,
        session: 'main',
        orientation: 'h',
        percent: 50,
        argv: ['tail', '-F', 'has\0nul'],
      }),
    ).rejects.toThrow(/contains '\\0'/)
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

// ---------------------------------------------------------------------------
// Strict appliance-mode (PR A) — verifies that the lockdown actually takes
// effect on a real tmux server. These tests prove the *behavior* is in place
// (history-limit 0, prefix None, only the four allowlist bindings, status-
// right hint visible, pane-died hook intact), not just that we sent the
// right argv.
// ---------------------------------------------------------------------------

const runShell = async (
  argv: readonly string[],
): Promise<{ readonly stdout: string; readonly exitCode: number }> => {
  const proc = Bun.spawn([...argv], { stdout: 'pipe', stderr: 'ignore' })
  const stdout = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  return { stdout, exitCode }
}

describe.skipIf(!canRun)('initOrchSession strict-sandbox lockdown on real tmux', () => {
  const initStrict = async (socket: SocketName) => {
    const tmux = new RealTmuxService({ processService: new BunProcessService() })
    await initOrchSession(tmux, new BunFsService(), {
      socket,
      session: 'main',
      width: 200,
      height: 50,
      paneDiedCommand: `run-shell "tmux -L ${socket} wait-for -S pane-exit-#{hook_pane}"`,
    })
    return tmux
  }

  it('list-keys -T root contains exactly the six allowlist bindings after init', async () => {
    const socket = newSocket('strict-root-keys')
    await initStrict(socket)

    const { stdout, exitCode } = await runShell(['tmux', '-L', socket, 'list-keys', '-T', 'root'])
    expect(exitCode).toBe(0)
    const lines = stdout.split('\n').filter((l) => l.trim().length > 0)
    expect(lines).toHaveLength(6)
    expect(stdout).toContain('MouseDrag1Border')
    expect(stdout).toContain('MouseDown1Pane')
    expect(stdout).toContain('M-Left')
    expect(stdout).toContain('M-Right')
    expect(stdout).toContain('WheelUpPane')
    expect(stdout).toContain('WheelDownPane')
    // Smart-wheel rule preserves the nested if-shell shape on round-trip.
    expect(stdout).toContain('mouse_any_flag')
    expect(stdout).toContain('alternate_on')
    expect(stdout).toContain('copy-mode -e')
  })

  it('list-keys for the prefix table is empty after init (no prefix-rooted commands survive the wipe)', async () => {
    const socket = newSocket('strict-empty-prefix-table')
    await initStrict(socket)

    // tmux `list-keys -T <table>` returns exit 1 with stderr "table … is
    // empty" once every binding is wiped — empty stdout regardless of exit
    // code is the contract that proves the table is gone.
    const { stdout } = await runShell(['tmux', '-L', socket, 'list-keys', '-T', 'prefix'])
    expect(stdout.trim()).toBe('')
  })

  it('list-keys for copy-mode and copy-mode-vi tables contain the audited allowlist (exit + scroll) after init', async () => {
    const socket = newSocket('strict-copy-mode-allowlist')
    await initStrict(socket)

    // Copy-mode tables are intentionally NOT empty — the strict-sandbox
    // bug fix installs a minimal allowlist (q/Escape/C-c → cancel; j/k/Up/
    // Down/PageUp/PageDown/g/G/wheel → scroll) so a stray copy-mode entry
    // from the WheelUpPane rule does not trap the user. The bindings are
    // identical under both `copy-mode` and `copy-mode-vi`.
    for (const table of ['copy-mode', 'copy-mode-vi'] as const) {
      const { stdout } = await runShell(['tmux', '-L', socket, 'list-keys', '-T', table])
      // Exit keys — the load-bearing escapes from copy-mode.
      expect(stdout).toContain(' q ')
      expect(stdout).toContain(' Escape ')
      expect(stdout).toContain(' C-c ')
      expect(stdout).toContain('cancel')
      // Scroll keys — keyboard + wheel. tmux normalizes the displayed key
      // name: `PageUp` is shown as `PPage`, `PageDown` as `NPage`.
      expect(stdout).toContain(' j ')
      expect(stdout).toContain(' k ')
      expect(stdout).toContain(' Up ')
      expect(stdout).toContain(' Down ')
      expect(stdout).toContain(' PPage ')
      expect(stdout).toContain(' NPage ')
      expect(stdout).toContain(' g ')
      expect(stdout).toContain(' G ')
      expect(stdout).toContain('WheelUpPane')
      expect(stdout).toContain('WheelDownPane')
      expect(stdout).toContain('scroll-up')
      expect(stdout).toContain('scroll-down')
      expect(stdout).toContain('history-top')
      expect(stdout).toContain('history-bottom')
    }
  })

  it('show-options -g prefix returns None after init so C-b is inert', async () => {
    const socket = newSocket('strict-prefix-none')
    await initStrict(socket)

    const { stdout, exitCode } = await runShell([
      'tmux',
      '-L',
      socket,
      'show-options',
      '-g',
      'prefix',
    ])
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/prefix\s+None/)
  })

  it('display-message #{history_limit} is >= 50000 on the initial pane after init', async () => {
    // tmux/tmux#4705 — history-limit is captured at pane allocation. The
    // `-f` config path applied in initOrchSession is the only way to make
    // the initial pane's grid honor a non-default buffer size. We assert on
    // `#{history_limit}` (the configured ceiling) so the test is independent
    // of how much output the pane has rendered.
    const socket = newSocket('strict-history-initial')
    const tmux = await initStrict(socket)

    const initial = await tmux.listPanes({ socket, session: 'main', format: '#{pane_id}' })
    const first = initial[0]
    if (first === undefined) throw new Error('expected initial pane')
    const initialPane = paneId(first)

    const limit = await tmux.displayMessage({
      socket,
      target: initialPane,
      format: '#{history_limit}',
    })
    expect(Number(limit)).toBeGreaterThanOrEqual(50000)
  })

  it('display-message #{history_limit} is >= 50000 on a freshly split pane', async () => {
    const socket = newSocket('strict-history-split')
    const tmux = await initStrict(socket)

    const split = await tmux.splitPane({
      socket,
      session: 'main',
      orientation: 'h',
      percent: 30,
      command: 'cat',
    })

    // Drive some output so the buffer has something in it — the actual
    // assertion is on `#{history_limit}`, not `#{history_size}`. The output
    // is incidental, but it documents that the buffer accepts and retains
    // input under the new ceiling.
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n')
    await tmux.sendKeys({ socket, target: split, keys: [lines], enter: true })
    await new Promise((r) => setTimeout(r, 200))

    const limit = await tmux.displayMessage({
      socket,
      target: split,
      format: '#{history_limit}',
    })
    expect(Number(limit)).toBeGreaterThanOrEqual(50000)
  })

  it('show-hooks -g pane-died reveals the lifecycle hook still installed after the unbind-key wipe', async () => {
    // Hooks live in a separate namespace from key tables, so `unbind-key -a`
    // must not affect them. Querying the specific hook returns its command;
    // `show-hooks -g` without a name lists every default hook label and is
    // a poor signal for "this specific hook is set".
    const socket = newSocket('strict-hooks-survive')
    await initStrict(socket)

    const { stdout, exitCode } = await runShell([
      'tmux',
      '-L',
      socket,
      'show-hooks',
      '-g',
      'pane-died',
    ])
    expect(exitCode).toBe(0)
    expect(stdout).toContain('pane-died')
    expect(stdout).toContain('pane-exit-#{hook_pane}')
  })

  it('show-options -g status-right contains the in-pane scroll hint after init', async () => {
    const socket = newSocket('strict-status-right')
    await initStrict(socket)

    const { stdout, exitCode } = await runShell([
      'tmux',
      '-L',
      socket,
      'show-options',
      '-g',
      'status-right',
    ])
    expect(exitCode).toBe(0)
    // The hint now leads with in-pane scroll (the new primary path through
    // the smart-wheel binding and the Ink keymap).
    expect(stdout).toContain('scroll')
    expect(stdout).toContain('wheel')
  })
})
