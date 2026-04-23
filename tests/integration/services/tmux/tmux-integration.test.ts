// Integration tests: RealTmuxService composed with FakeProcessService.
// These tests verify that tmux argv construction is exactly what we expect
// to send over the process seam — every flag, positional, and ordering.

import { describe, expect, it } from 'bun:test'
import { FakeProcessService } from '../../../../src/services/process/index.ts'
import {
  paneId,
  RealTmuxService,
  socketName,
  TmuxCommandError,
} from '../../../../src/services/tmux/index.ts'

describe('RealTmuxService.createSession', () => {
  it('sends new-session with detached flag, socket, window geometry, and /dev/null config', async () => {
    const proc = new FakeProcessService()
    const expectedArgv = [
      'tmux',
      '-L',
      'orch-abc',
      '-f',
      '/dev/null',
      'new-session',
      '-d',
      '-s',
      'main',
      '-x',
      '200',
      '-y',
      '50',
    ]
    proc.when(expectedArgv).respondWith({ exitCode: 0 })
    const tmux = new RealTmuxService({ processService: proc })

    await tmux.createSession({
      socket: socketName('orch-abc'),
      session: 'main',
      width: 200,
      height: 50,
    })
  })

  it('throws TmuxCommandError with the captured stderr when new-session fails', async () => {
    const proc = new FakeProcessService()
    proc
      .when([
        'tmux',
        '-L',
        'orch-abc',
        '-f',
        '/dev/null',
        'new-session',
        '-d',
        '-s',
        'main',
        '-x',
        '80',
        '-y',
        '24',
      ])
      .respondWith({ exitCode: 1, stderr: ['duplicate session'] })
    const tmux = new RealTmuxService({ processService: proc })

    await expect(
      tmux.createSession({
        socket: socketName('orch-abc'),
        session: 'main',
        width: 80,
        height: 24,
      }),
    ).rejects.toBeInstanceOf(TmuxCommandError)
  })
})

describe('RealTmuxService.splitPane', () => {
  it('returns the parsed pane id from split-window -P output', async () => {
    const proc = new FakeProcessService()
    proc
      .when([
        'tmux',
        '-L',
        'orch-1',
        'split-window',
        '-t',
        'main',
        '-h',
        '-p',
        '70',
        '-P',
        '-F',
        '#{pane_id}',
        'cat',
      ])
      .respondWith({ exitCode: 0, stdout: ['%42'] })
    const tmux = new RealTmuxService({ processService: proc })

    const id = await tmux.splitPane({
      socket: socketName('orch-1'),
      session: 'main',
      orientation: 'h',
      percent: 70,
      command: 'cat',
    })

    expect(id).toBe(paneId('%42'))
  })

  it('throws when split-window returns a malformed pane id', async () => {
    const proc = new FakeProcessService()
    proc
      .when([
        'tmux',
        '-L',
        'orch-1',
        'split-window',
        '-t',
        'main',
        '-v',
        '-p',
        '50',
        '-P',
        '-F',
        '#{pane_id}',
      ])
      .respondWith({ exitCode: 0, stdout: ['not-a-pane-id'] })
    const tmux = new RealTmuxService({ processService: proc })

    await expect(
      tmux.splitPane({
        socket: socketName('orch-1'),
        session: 'main',
        orientation: 'v',
        percent: 50,
      }),
    ).rejects.toThrow('unexpected pane id')
  })
})

describe('RealTmuxService.sendKeys', () => {
  it('passes each key verbatim after -l to prevent metacharacter interpretation', async () => {
    const proc = new FakeProcessService()
    const payload = '; rm -rf /'
    proc
      .when(['tmux', '-L', 'orch-1', 'send-keys', '-t', '%1', '-l', payload])
      .respondWith({ exitCode: 0 })
    const tmux = new RealTmuxService({ processService: proc })

    await tmux.sendKeys({
      socket: socketName('orch-1'),
      target: paneId('%1'),
      keys: [payload],
    })
  })

  it('sends a separate Enter invocation when opts.enter is true', async () => {
    const proc = new FakeProcessService()
    proc
      .when(['tmux', '-L', 'orch-1', 'send-keys', '-t', '%2', '-l', 'echo hi'])
      .respondWith({ exitCode: 0 })
    proc
      .when(['tmux', '-L', 'orch-1', 'send-keys', '-t', '%2', 'Enter'])
      .respondWith({ exitCode: 0 })
    const tmux = new RealTmuxService({ processService: proc })

    await tmux.sendKeys({
      socket: socketName('orch-1'),
      target: paneId('%2'),
      keys: ['echo hi'],
      enter: true,
    })
  })
})

describe('RealTmuxService.waitFor', () => {
  it('resolves once the underlying wait-for subprocess exits zero', async () => {
    const proc = new FakeProcessService()
    proc.when(['tmux', '-L', 'orch-1', 'wait-for', 'pane-exit-1']).respondWith({ exitCode: 0 })
    const tmux = new RealTmuxService({ processService: proc })

    await tmux.waitFor({
      socket: socketName('orch-1'),
      channel: 'pane-exit-1',
      timeoutMs: 5000,
    })
  })
})

describe('RealTmuxService.displayMessage', () => {
  it('returns the stdout line as the rendered format', async () => {
    const proc = new FakeProcessService()
    proc
      .when(['tmux', '-L', 'orch-1', 'display-message', '-p', '-t', '%1', '#{pane_dead}'])
      .respondWith({ exitCode: 0, stdout: ['1'] })
    const tmux = new RealTmuxService({ processService: proc })

    const result = await tmux.displayMessage({
      socket: socketName('orch-1'),
      target: paneId('%1'),
      format: '#{pane_dead}',
    })

    expect(result).toBe('1')
  })

  it('throws when tmux returns exit 0 with empty output (invalid pane)', async () => {
    const proc = new FakeProcessService()
    proc
      .when(['tmux', '-L', 'orch-1', 'display-message', '-p', '-t', '%99', '#{pane_dead}'])
      .respondWith({ exitCode: 0, stdout: [] })
    const tmux = new RealTmuxService({ processService: proc })

    await expect(
      tmux.displayMessage({
        socket: socketName('orch-1'),
        target: paneId('%99'),
        format: '#{pane_dead}',
      }),
    ).rejects.toThrow('empty output')
  })
})

describe('RealTmuxService.setOption and setHook', () => {
  it('builds a global set-option argv when global is true', async () => {
    const proc = new FakeProcessService()
    proc
      .when(['tmux', '-L', 'orch-1', 'set-option', '-g', 'remain-on-exit', 'on'])
      .respondWith({ exitCode: 0 })
    const tmux = new RealTmuxService({ processService: proc })

    await tmux.setOption({
      socket: socketName('orch-1'),
      target: 'main',
      name: 'remain-on-exit',
      value: 'on',
      global: true,
    })
  })

  it('builds a global set-hook argv with the hook name and command', async () => {
    const proc = new FakeProcessService()
    proc
      .when(['tmux', '-L', 'orch-1', 'set-hook', '-g', 'pane-died', 'run-shell "true"'])
      .respondWith({ exitCode: 0 })
    const tmux = new RealTmuxService({ processService: proc })

    await tmux.setHook({
      socket: socketName('orch-1'),
      hook: 'pane-died',
      command: 'run-shell "true"',
      global: true,
    })
  })
})

describe('RealTmuxService.killPane, selectPane, attachSession, signalChannel', () => {
  it('sends the expected argv for each single-purpose method', async () => {
    const proc = new FakeProcessService()
    proc.when(['tmux', '-L', 'orch-1', 'kill-pane', '-t', '%1']).respondWith({ exitCode: 0 })
    proc.when(['tmux', '-L', 'orch-1', 'select-pane', '-t', '%2']).respondWith({ exitCode: 0 })
    proc.when(['tmux', '-L', 'orch-1', 'attach-session', '-t', 'main']).respondWith({ exitCode: 0 })
    proc.when(['tmux', '-L', 'orch-1', 'wait-for', '-S', 'ch-1']).respondWith({ exitCode: 0 })
    const tmux = new RealTmuxService({ processService: proc })

    await tmux.killPane({ socket: socketName('orch-1'), target: paneId('%1') })
    await tmux.selectPane({ socket: socketName('orch-1'), target: paneId('%2') })
    await tmux.attachSession({ socket: socketName('orch-1'), session: 'main' })
    await tmux.signalChannel({ socket: socketName('orch-1'), channel: 'ch-1' })
  })
})

// ---------------------------------------------------------------------------
// capturePane / pipePane / listPanes (phase 13c additions)
// ---------------------------------------------------------------------------

describe('RealTmuxService.capturePane', () => {
  it('builds capture-pane argv with -p and appends -e/-J when requested', async () => {
    const proc = new FakeProcessService()
    proc
      .when(['tmux', '-L', 'orch-1', 'capture-pane', '-p', '-t', '%1', '-e', '-J'])
      .respondWith({ exitCode: 0, stdout: ['hello\x1b[0m', 'world'] })
    const tmux = new RealTmuxService({ processService: proc })

    const out = await tmux.capturePane({
      socket: socketName('orch-1'),
      target: paneId('%1'),
      escapeCodes: true,
      joinWrapped: true,
    })

    expect(out).toBe('hello\x1b[0m\nworld')
  })

  it('omits -e and -J flags when capturePane is called with defaults', async () => {
    const proc = new FakeProcessService()
    proc
      .when(['tmux', '-L', 'orch-1', 'capture-pane', '-p', '-t', '%9'])
      .respondWith({ exitCode: 0, stdout: ['plain'] })
    const tmux = new RealTmuxService({ processService: proc })

    expect(await tmux.capturePane({ socket: socketName('orch-1'), target: paneId('%9') })).toBe(
      'plain',
    )
  })
})

describe('RealTmuxService.pipePane', () => {
  it('builds pipe-pane argv with -O and the command as the final positional', async () => {
    const proc = new FakeProcessService()
    proc
      .when(['tmux', '-L', 'orch-1', 'pipe-pane', '-O', '-t', '%1', 'cat >> /tmp/log'])
      .respondWith({ exitCode: 0 })
    const tmux = new RealTmuxService({ processService: proc })

    await tmux.pipePane({
      socket: socketName('orch-1'),
      target: paneId('%1'),
      command: 'cat >> /tmp/log',
      append: true,
    })
  })

  it('passes an empty command string to tear down an existing pipe', async () => {
    const proc = new FakeProcessService()
    proc.when(['tmux', '-L', 'orch-1', 'pipe-pane', '-t', '%1', '']).respondWith({ exitCode: 0 })
    const tmux = new RealTmuxService({ processService: proc })

    await tmux.pipePane({
      socket: socketName('orch-1'),
      target: paneId('%1'),
      command: '',
    })
  })
})

describe('RealTmuxService.listPanes', () => {
  it('splits the format-rendered stdout into one entry per non-empty line', async () => {
    const proc = new FakeProcessService()
    proc
      .when(['tmux', '-L', 'orch-1', 'list-panes', '-t', 'main', '-F', '#{pane_id}'])
      .respondWith({ exitCode: 0, stdout: ['%1', '%2', '%3'] })
    const tmux = new RealTmuxService({ processService: proc })

    const panes = await tmux.listPanes({
      socket: socketName('orch-1'),
      session: 'main',
      format: '#{pane_id}',
    })

    expect(panes).toEqual(['%1', '%2', '%3'])
  })

  it('throws TmuxCommandError when list-panes exits non-zero', async () => {
    const proc = new FakeProcessService()
    proc
      .when(['tmux', '-L', 'orch-1', 'list-panes', '-t', 'missing', '-F', '#{pane_id}'])
      .respondWith({ exitCode: 1, stderr: ['session not found'] })
    const tmux = new RealTmuxService({ processService: proc })

    await expect(
      tmux.listPanes({
        socket: socketName('orch-1'),
        session: 'missing',
        format: '#{pane_id}',
      }),
    ).rejects.toBeInstanceOf(TmuxCommandError)
  })
})

describe('RealTmuxService.respawnPane', () => {
  it('composes tmux respawn-pane -k -t <pane> <argv...> with no shell interpretation', async () => {
    const proc = new FakeProcessService()
    // The argv entries include a shell-meta step name. If the composer ever
    // collapses argv to a string, this test would fail to match and explode.
    proc
      .when([
        'tmux',
        '-L',
        'orch-1',
        'respawn-pane',
        '-k',
        '-t',
        '%2',
        'claude',
        '--prompt',
        'plan; rm -rf ~',
      ])
      .respondWith({ exitCode: 0 })
    const tmux = new RealTmuxService({ processService: proc })

    await tmux.respawnPane({
      socket: socketName('orch-1'),
      target: paneId('%2'),
      argv: ['claude', '--prompt', 'plan; rm -rf ~'],
      killRunning: true,
    })
  })

  it('omits -k when killRunning is false', async () => {
    const proc = new FakeProcessService()
    proc
      .when(['tmux', '-L', 'orch-1', 'respawn-pane', '-t', '%3', 'cat'])
      .respondWith({ exitCode: 0 })
    const tmux = new RealTmuxService({ processService: proc })

    await tmux.respawnPane({
      socket: socketName('orch-1'),
      target: paneId('%3'),
      argv: ['cat'],
      killRunning: false,
    })
  })

  it('throws TmuxCommandError on non-zero exit', async () => {
    const proc = new FakeProcessService()
    proc
      .when(['tmux', '-L', 'orch-1', 'respawn-pane', '-k', '-t', '%9', 'cat'])
      .respondWith({ exitCode: 1, stderr: ['pane not found'] })
    const tmux = new RealTmuxService({ processService: proc })

    await expect(
      tmux.respawnPane({
        socket: socketName('orch-1'),
        target: paneId('%9'),
        argv: ['cat'],
        killRunning: true,
      }),
    ).rejects.toBeInstanceOf(TmuxCommandError)
  })
})
