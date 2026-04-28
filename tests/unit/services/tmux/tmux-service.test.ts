import { describe, expect, it } from 'bun:test'
import {
  FakeTmuxService,
  initOrchSession,
  paneId,
  socketName,
  TmuxCommandError,
} from '../../../../src/services/tmux/index.ts'

// ---------------------------------------------------------------------------
// Branded constructors
// ---------------------------------------------------------------------------

describe('paneId', () => {
  it('accepts tmux pane ids shaped like %42', () => {
    expect(paneId('%42')).toBe('%42' as ReturnType<typeof paneId>)
  })

  it('accepts single-digit pane ids like %0', () => {
    expect(paneId('%0')).toBe('%0' as ReturnType<typeof paneId>)
  })

  it('rejects strings that do not start with a percent sign', () => {
    expect(() => paneId('42')).toThrow('invalid pane id')
  })

  it('rejects strings containing shell metacharacters', () => {
    expect(() => paneId('%1;rm -rf /')).toThrow('invalid pane id')
  })

  it('rejects the empty string', () => {
    expect(() => paneId('')).toThrow('invalid pane id')
  })
})

describe('socketName', () => {
  it('accepts lowercase alphanumerics with dashes', () => {
    expect(socketName('orch-run-001')).toBe('orch-run-001' as ReturnType<typeof socketName>)
  })

  it('rejects uppercase characters', () => {
    expect(() => socketName('Orch')).toThrow('invalid socket')
  })

  it('rejects whitespace', () => {
    expect(() => socketName('orch run')).toThrow('invalid socket')
  })

  it('rejects shell metacharacters that could escape run-shell templates', () => {
    expect(() => socketName('orch;rm')).toThrow('invalid socket')
    expect(() => socketName('orch$(id)')).toThrow('invalid socket')
    expect(() => socketName('orch`whoami`')).toThrow('invalid socket')
  })

  it('rejects the empty string', () => {
    expect(() => socketName('')).toThrow('invalid socket')
  })
})

// ---------------------------------------------------------------------------
// TmuxCommandError shape
// ---------------------------------------------------------------------------

describe('TmuxCommandError', () => {
  it('preserves the exit code and stderr passed to the constructor', () => {
    const err = new TmuxCommandError(1, 'no server running', 'tmux failed (exit 1)')

    expect(err.exitCode).toBe(1)
    expect(err.stderr).toBe('no server running')
    expect(err.message).toBe('tmux failed (exit 1)')
    expect(err.name).toBe('TmuxCommandError')
  })

  it('survives an instanceof check after being thrown', () => {
    const err = new TmuxCommandError(2, '', 'boom')
    expect(err).toBeInstanceOf(TmuxCommandError)
    expect(err).toBeInstanceOf(Error)
  })
})

// ---------------------------------------------------------------------------
// FakeTmuxService — recording
// ---------------------------------------------------------------------------

describe('FakeTmuxService recording', () => {
  it('records every method call with its options in order', async () => {
    const tmux = new FakeTmuxService()
    const socket = socketName('orch-1')

    await tmux.createSession({ socket, session: 'main', width: 200, height: 50 })
    await tmux.sendKeys({ socket, target: paneId('%1'), keys: ['hello'], enter: true })
    await tmux.killPane({ socket, target: paneId('%1') })

    expect(tmux.recordedCalls).toHaveLength(3)
    expect(tmux.recordedCalls[0]?.method).toBe('createSession')
    expect(tmux.recordedCalls[1]?.method).toBe('sendKeys')
    expect(tmux.recordedCalls[2]?.method).toBe('killPane')
  })

  it('exposes recordedCalls as a read-only view that reflects later calls', async () => {
    const tmux = new FakeTmuxService()
    const calls = tmux.recordedCalls

    expect(calls).toHaveLength(0)
    await tmux.attachSession({ socket: socketName('orch-1'), session: 'main' })
    expect(calls).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// FakeTmuxService — scripted return values
// ---------------------------------------------------------------------------

describe('FakeTmuxService.splitPane', () => {
  it('returns scripted pane ids in FIFO order', async () => {
    const tmux = new FakeTmuxService()
    tmux.nextPaneId(paneId('%10'))
    tmux.nextPaneId(paneId('%11'))
    const socket = socketName('orch-1')

    const first = await tmux.splitPane({ socket, session: 'main', orientation: 'h', percent: 30 })
    const second = await tmux.splitPane({ socket, session: 'main', orientation: 'v', percent: 50 })

    expect(first).toBe(paneId('%10'))
    expect(second).toBe(paneId('%11'))
  })

  it('falls back to a synthetic pane id when none is scripted', async () => {
    const tmux = new FakeTmuxService()
    const socket = socketName('orch-1')

    const result = await tmux.splitPane({ socket, session: 'main', orientation: 'h', percent: 30 })

    expect(result).toMatch(/^%\d+$/)
  })
})

describe('FakeTmuxService.displayMessage', () => {
  it('returns scripted display results in FIFO order', async () => {
    const tmux = new FakeTmuxService()
    tmux.setDisplayResult('0')
    tmux.setDisplayResult('1')
    const socket = socketName('orch-1')

    const alive = await tmux.displayMessage({
      socket,
      target: paneId('%1'),
      format: '#{pane_dead}',
    })
    const dead = await tmux.displayMessage({
      socket,
      target: paneId('%1'),
      format: '#{pane_dead}',
    })

    expect(alive).toBe('0')
    expect(dead).toBe('1')
  })

  it('throws a loud error when no result is scripted', async () => {
    const tmux = new FakeTmuxService()
    const socket = socketName('orch-1')

    await expect(
      tmux.displayMessage({ socket, target: paneId('%1'), format: '#{pane_dead}' }),
    ).rejects.toThrow('no displayMessage result scripted')
  })
})

// ---------------------------------------------------------------------------
// initOrchSession lifecycle helper
// ---------------------------------------------------------------------------

describe('initOrchSession', () => {
  it('creates the session, sets remain-on-exit and mouse, and registers the pane-died hook in order', async () => {
    const tmux = new FakeTmuxService()
    const socket = socketName('orch-1')

    await initOrchSession(tmux, {
      socket,
      session: 'main',
      width: 200,
      height: 50,
      paneDiedCommand: 'run-shell "tmux wait-for -S done"',
    })

    const [first, second, third, fourth] = tmux.recordedCalls
    expect(first?.method).toBe('createSession')
    expect(second?.method).toBe('setOption')
    expect(third?.method).toBe('setOption')
    expect(fourth?.method).toBe('setHook')
  })

  it('enables mouse mode globally so users can drag pane borders to resize', async () => {
    const tmux = new FakeTmuxService()

    await initOrchSession(tmux, {
      socket: socketName('orch-1'),
      session: 'main',
      width: 200,
      height: 50,
      paneDiedCommand: 'run-shell "true"',
    })

    const mouseCall = tmux.recordedCalls.find(
      (c) => c.method === 'setOption' && c.opts.name === 'mouse',
    )
    expect(mouseCall?.method).toBe('setOption')
    if (mouseCall?.method === 'setOption') {
      expect(mouseCall.opts.value).toBe('on')
      expect(mouseCall.opts.global).toBe(true)
    }
  })

  it('uses remain-on-exit "on" so the pane-died hook fires for every agent exit', async () => {
    const tmux = new FakeTmuxService()

    await initOrchSession(tmux, {
      socket: socketName('orch-1'),
      session: 'main',
      width: 200,
      height: 50,
      paneDiedCommand: 'run-shell "true"',
    })

    const setOptionCall = tmux.recordedCalls.find((c) => c.method === 'setOption')
    expect(setOptionCall?.method).toBe('setOption')
    if (setOptionCall?.method === 'setOption') {
      expect(setOptionCall.opts.name).toBe('remain-on-exit')
      expect(setOptionCall.opts.value).toBe('on')
      expect(setOptionCall.opts.global).toBe(true)
    }
  })

  it('registers the pane-died hook globally with the caller-provided command', async () => {
    const tmux = new FakeTmuxService()

    await initOrchSession(tmux, {
      socket: socketName('orch-1'),
      session: 'main',
      width: 200,
      height: 50,
      paneDiedCommand: 'run-shell "tmux -L orch-1 wait-for -S pane-exit-#{hook_pane}"',
    })

    const hookCall = tmux.recordedCalls.find((c) => c.method === 'setHook')
    expect(hookCall?.method).toBe('setHook')
    if (hookCall?.method === 'setHook') {
      expect(hookCall.opts.hook).toBe('pane-died')
      expect(hookCall.opts.global).toBe(true)
      expect(hookCall.opts.command).toContain('pane-exit-#{hook_pane}')
    }
  })
})

// ---------------------------------------------------------------------------
// FakeTmuxService.capturePane / pipePane / listPanes (phase 13c additions)
// ---------------------------------------------------------------------------

describe('FakeTmuxService.capturePane', () => {
  it('records the capture call and returns the scripted result', async () => {
    const tmux = new FakeTmuxService()
    tmux.setCaptureResult('hello world')

    const out = await tmux.capturePane({
      socket: socketName('orch-1'),
      target: paneId('%7'),
      escapeCodes: true,
    })

    expect(out).toBe('hello world')
    const last = tmux.recordedCalls.at(-1)
    expect(last?.method).toBe('capturePane')
  })

  it('returns an empty string when no capture result is scripted', async () => {
    const tmux = new FakeTmuxService()
    const out = await tmux.capturePane({
      socket: socketName('orch-1'),
      target: paneId('%7'),
    })
    expect(out).toBe('')
  })
})

describe('FakeTmuxService.pipePane', () => {
  it('records the pipe command and append flag for observe-mode assertions', async () => {
    const tmux = new FakeTmuxService()

    await tmux.pipePane({
      socket: socketName('orch-1'),
      target: paneId('%7'),
      command: 'cat >> /tmp/out.log',
      append: true,
    })

    const call = tmux.recordedCalls.at(-1)
    expect(call?.method).toBe('pipePane')
    if (call?.method === 'pipePane') {
      expect(call.opts.command).toBe('cat >> /tmp/out.log')
      expect(call.opts.append).toBe(true)
    }
  })
})

describe('FakeTmuxService.listPanes', () => {
  it('returns scripted pane lines in FIFO order', async () => {
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%1', '%2'])
    tmux.setListPanesResult(['%9'])

    const first = await tmux.listPanes({
      socket: socketName('orch-1'),
      session: 'main',
      format: '#{pane_id}',
    })
    const second = await tmux.listPanes({
      socket: socketName('orch-1'),
      session: 'main',
      format: '#{pane_id}',
    })

    expect(first).toEqual(['%1', '%2'])
    expect(second).toEqual(['%9'])
  })

  it('returns an empty list when no result is scripted', async () => {
    const tmux = new FakeTmuxService()
    const out = await tmux.listPanes({
      socket: socketName('orch-1'),
      session: 'main',
      format: '#{pane_id}',
    })
    expect(out).toEqual([])
  })
})

describe('FakeTmuxService.killSession', () => {
  it('records the session teardown call so host tests can assert it fired', async () => {
    const tmux = new FakeTmuxService()
    const socket = socketName('orch-1')

    await tmux.killSession({ socket, session: 'orch' })

    const call = tmux.recordedCalls.at(-1)
    expect(call?.method).toBe('killSession')
    if (call?.method === 'killSession') {
      expect(call.opts.socket).toBe(socket)
      expect(call.opts.session).toBe('orch')
    }
  })

  it('stays a no-op when called twice so teardown can be idempotent', async () => {
    const tmux = new FakeTmuxService()
    const socket = socketName('orch-1')

    await tmux.killSession({ socket, session: 'orch' })
    await tmux.killSession({ socket, session: 'orch' })

    const killCalls = tmux.recordedCalls.filter((c) => c.method === 'killSession')
    expect(killCalls).toHaveLength(2)
  })
})

describe('FakeTmuxService.respawnPane', () => {
  it('records argv verbatim even when entries contain shell metacharacters', async () => {
    const tmux = new FakeTmuxService()
    const socket = socketName('orch-1')
    const target = paneId('%2')

    // A step name crafted to inject if tmux ever ran argv through a shell.
    // FakeTmuxService proves the recording contract; RealTmuxService relies
    // on array argv so execvp never sees a shell.
    await tmux.respawnPane({
      socket,
      target,
      argv: ['claude', '--prompt', 'plan; rm -rf ~'],
      killRunning: true,
    })

    const call = tmux.recordedCalls[0]
    expect(call?.method).toBe('respawnPane')
    if (call?.method !== 'respawnPane') throw new Error('expected respawnPane call')
    expect(call.opts.killRunning).toBe(true)
    expect(call.opts.argv).toEqual(['claude', '--prompt', 'plan; rm -rf ~'])
    expect(call.opts.target).toBe(target)
  })

  it('records killRunning=false when the caller opts out of -k', async () => {
    const tmux = new FakeTmuxService()

    await tmux.respawnPane({
      socket: socketName('orch-1'),
      target: paneId('%3'),
      argv: ['cat'],
      killRunning: false,
    })

    const call = tmux.recordedCalls[0]
    if (call?.method !== 'respawnPane') throw new Error('expected respawnPane call')
    expect(call.opts.killRunning).toBe(false)
  })
})

describe('FakeTmuxService.waitFor', () => {
  it('records a wait without timeoutMs so interactive callers can assert the no-timeout contract', async () => {
    const tmux = new FakeTmuxService()

    await tmux.waitFor({
      socket: socketName('orch-1'),
      channel: 'pane-exit-%42',
    })

    const call = tmux.recordedCalls.at(-1)
    if (call?.method !== 'waitFor') throw new Error('expected waitFor call')
    expect(call.opts.channel).toBe('pane-exit-%42')
    expect(call.opts.timeoutMs).toBeUndefined()
  })

  it('records the timeoutMs value verbatim when a caller supplies one', async () => {
    const tmux = new FakeTmuxService()

    await tmux.waitFor({
      socket: socketName('orch-1'),
      channel: 'pane-exit-%42',
      timeoutMs: 5000,
    })

    const call = tmux.recordedCalls.at(-1)
    if (call?.method !== 'waitFor') throw new Error('expected waitFor call')
    expect(call.opts.timeoutMs).toBe(5000)
  })
})
