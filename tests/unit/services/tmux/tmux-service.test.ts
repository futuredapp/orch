// MIGRATED → tests-new/tmux-argv/services/tmux/tmux-service.test.ts (parent U13) — relocated verbatim (import paths only); kept skipped on disk (D2).
import { describe, expect, it } from 'bun:test'
import { FakeProcessService } from '../../../../src/services/process/fake-process-service.ts'
import {
  FakeTmuxService,
  paneId,
  RealTmuxService,
  socketName,
  TmuxCommandError,
} from '../../../../src/services/tmux/index.ts'

// ---------------------------------------------------------------------------
// Branded constructors
// ---------------------------------------------------------------------------

describe.skip('paneId', () => {
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

describe.skip('socketName', () => {
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

describe.skip('TmuxCommandError', () => {
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

describe.skip('FakeTmuxService recording', () => {
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

describe.skip('FakeTmuxService.splitPane', () => {
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

describe.skip('FakeTmuxService.createSession (initial pane id contract)', () => {
  it('returns the next scripted createSession pane id when one is queued', async () => {
    const tmux = new FakeTmuxService()
    const socket = socketName('orch-1')
    tmux.nextCreateSessionPaneId(paneId('%42'))

    const result = await tmux.createSession({ socket, session: 'orch', width: 80, height: 24 })

    expect(result.paneId).toBe(paneId('%42'))
  })

  it('falls back to an auto-synthesized pane id when no createSession id is scripted', async () => {
    const tmux = new FakeTmuxService()
    const socket = socketName('orch-1')

    const first = await tmux.createSession({ socket, session: 'a', width: 80, height: 24 })
    const second = await tmux.createSession({ socket, session: 'b', width: 80, height: 24 })

    expect(first.paneId).toMatch(/^%\d+$/)
    expect(second.paneId).toMatch(/^%\d+$/)
    expect(first.paneId).not.toBe(second.paneId)
  })

  it('does not consume the splitPane pane-id queue when createSession runs', async () => {
    // Distinct queues — scripting nextPaneId('%7') for splitPane must not be
    // siphoned off by a createSession call that doesn't get its own
    // nextCreateSessionPaneId. This is what keeps the existing controller
    // unit tests (which scripted nextPaneId for splitPane) working through
    // the refactor.
    const tmux = new FakeTmuxService()
    const socket = socketName('orch-1')
    tmux.nextPaneId(paneId('%7'))

    await tmux.createSession({ socket, session: 'orch', width: 80, height: 24 })
    const split = await tmux.splitPane({ socket, session: 'orch', orientation: 'h', percent: 50 })

    expect(split).toBe(paneId('%7'))
  })

  it('throws the next scripted createSession error and still records the call', async () => {
    const tmux = new FakeTmuxService()
    const socket = socketName('orch-1')
    tmux.nextCreateSessionError(
      new TmuxCommandError(1, 'session already exists', 'tmux new-session failed'),
    )

    await expect(
      tmux.createSession({ socket, session: 'orch', width: 80, height: 24 }),
    ).rejects.toBeInstanceOf(TmuxCommandError)

    const last = tmux.recordedCalls.at(-1)
    expect(last?.method).toBe('createSession')
  })

  it('records the new pane id in paneIdsForSession after createSession resolves', async () => {
    const tmux = new FakeTmuxService()
    const socket = socketName('orch-1')
    tmux.nextCreateSessionPaneId(paneId('%51'))

    await tmux.createSession({ socket, session: 'orch-src-live-step1', width: 80, height: 24 })

    expect(tmux.paneIdsForSession(socket, 'orch-src-live-step1')).toEqual([paneId('%51')])
  })

  it('returns an empty array from paneIdsForSession for unknown sessions', async () => {
    const tmux = new FakeTmuxService()
    const socket = socketName('orch-1')

    expect(tmux.paneIdsForSession(socket, 'never-created')).toEqual([])
  })

  it('clears paneIdsForSession when killSession fires for that session', async () => {
    const tmux = new FakeTmuxService()
    const socket = socketName('orch-1')
    tmux.nextCreateSessionPaneId(paneId('%60'))
    await tmux.createSession({ socket, session: 'orch-src-x', width: 80, height: 24 })
    expect(tmux.paneIdsForSession(socket, 'orch-src-x')).toEqual([paneId('%60')])

    await tmux.killSession({ socket, session: 'orch-src-x' })

    expect(tmux.paneIdsForSession(socket, 'orch-src-x')).toEqual([])
  })

  it('clears every paneIdsForSession entry on the socket when killServer fires', async () => {
    const tmux = new FakeTmuxService()
    const socket = socketName('orch-1')
    tmux.nextCreateSessionPaneId(paneId('%70'))
    await tmux.createSession({ socket, session: 'orch-src-a', width: 80, height: 24 })
    tmux.nextCreateSessionPaneId(paneId('%71'))
    await tmux.createSession({ socket, session: 'orch-src-b', width: 80, height: 24 })

    await tmux.killServer({ socket })

    expect(tmux.paneIdsForSession(socket, 'orch-src-a')).toEqual([])
    expect(tmux.paneIdsForSession(socket, 'orch-src-b')).toEqual([])
  })
})

describe.skip('FakeTmuxService.displayMessage', () => {
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

// initOrchSession is covered by tests/unit/services/tmux/session-init.test.ts —
// the strict-sandbox lockdown rewrote the call sequence, so the focused tests
// for shape, ordering, and option contents live there.

// ---------------------------------------------------------------------------
// FakeTmuxService.capturePane / pipePane / listPanes (phase 13c additions)
// ---------------------------------------------------------------------------

describe.skip('FakeTmuxService.capturePane', () => {
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

describe.skip('FakeTmuxService.pipePane', () => {
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

describe.skip('FakeTmuxService.listPanes', () => {
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

describe.skip('FakeTmuxService.killSession', () => {
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

describe.skip('FakeTmuxService.respawnPane', () => {
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

describe.skip('FakeTmuxService.swapPane', () => {
  it('records the swap call with src and dst pane ids in the order received', async () => {
    const tmux = new FakeTmuxService()
    const socket = socketName('orch-1')

    await tmux.swapPane({ socket, src: paneId('%5'), dst: paneId('%9') })

    const call = tmux.recordedCalls.at(-1)
    if (call?.method !== 'swapPane') throw new Error('expected swapPane call')
    expect(call.opts.src).toBe(paneId('%5'))
    expect(call.opts.dst).toBe(paneId('%9'))
  })
})

describe.skip('FakeTmuxService.splitPane argv variant', () => {
  it('records the argv shape separately from the command shape with env and cwd fields', async () => {
    const tmux = new FakeTmuxService()
    const socket = socketName('orch-1')

    await tmux.splitPane({
      socket,
      session: 'orch-src-live-plan',
      orientation: 'h',
      percent: 30,
      argv: ['tail', '-n', '5000', '-F', '/tmp/foo.log'],
      env: { FORCE_COLOR: '3' },
    })

    const call = tmux.recordedCalls.at(-1)
    if (call?.method !== 'splitPane') throw new Error('expected splitPane call')
    expect(call.opts.argv).toEqual(['tail', '-n', '5000', '-F', '/tmp/foo.log'])
    expect(call.opts.env).toEqual({ FORCE_COLOR: '3' })
    expect(call.opts.command).toBeUndefined()
  })

  it('records argv elements verbatim even when they contain shell metacharacters', async () => {
    const tmux = new FakeTmuxService()

    await tmux.splitPane({
      socket: socketName('orch-1'),
      session: 'orch-src-live-plan',
      orientation: 'v',
      percent: 50,
      argv: ['tail', '-F', '/tmp/$(rm -rf ~).log'],
    })

    const call = tmux.recordedCalls.at(-1)
    if (call?.method !== 'splitPane') throw new Error('expected splitPane call')
    expect(call.opts.argv?.[2]).toBe('/tmp/$(rm -rf ~).log')
  })
})

describe.skip('FakeTmuxService.waitFor', () => {
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

// ---------------------------------------------------------------------------
// RealTmuxService.createSession argv shape (U2 — per-source tmux sessions)
// ---------------------------------------------------------------------------

describe.skip('RealTmuxService.createSession (argv shape + pane-id parsing)', () => {
  const SOCKET = socketName('orch-cs')

  it('includes -P -F #{pane_id} after the new-session geometry flags so tmux prints the initial pane id', async () => {
    const procs = new FakeProcessService()
    procs
      .when([
        'tmux',
        '-L',
        SOCKET,
        '-f',
        '/dev/null',
        'new-session',
        '-d',
        '-s',
        'orch',
        '-x',
        '200',
        '-y',
        '50',
        '-P',
        '-F',
        '#{pane_id}',
      ])
      .respondWith({ exitCode: 0, stdout: ['%17'] })
    const tmux = new RealTmuxService({ processService: procs })

    const result = await tmux.createSession({
      socket: SOCKET,
      session: 'orch',
      width: 200,
      height: 50,
    })

    expect(result.paneId).toBe(paneId('%17'))
  })

  it('returns the pane id parsed from stdout when a holder argv is appended after -P -F', async () => {
    // The command argv must come AFTER the -P -F flags so tmux interprets
    // them as flags, not as the new pane's shell command.
    const procs = new FakeProcessService()
    procs
      .when([
        'tmux',
        '-L',
        SOCKET,
        '-f',
        '/dev/null',
        'new-session',
        '-d',
        '-s',
        'orch-src-x',
        '-x',
        '120',
        '-y',
        '30',
        '-P',
        '-F',
        '#{pane_id}',
        'cat',
      ])
      .respondWith({ exitCode: 0, stdout: ['%42'] })
    const tmux = new RealTmuxService({ processService: procs })

    const result = await tmux.createSession({
      socket: SOCKET,
      session: 'orch-src-x',
      width: 120,
      height: 30,
      command: ['cat'],
    })

    expect(result.paneId).toBe(paneId('%42'))
  })

  it('throws TmuxCommandError when stdout has no parseable pane id (e.g. empty)', async () => {
    const procs = new FakeProcessService()
    procs
      .when([
        'tmux',
        '-L',
        SOCKET,
        '-f',
        '/dev/null',
        'new-session',
        '-d',
        '-s',
        'orch',
        '-x',
        '200',
        '-y',
        '50',
        '-P',
        '-F',
        '#{pane_id}',
      ])
      .respondWith({ exitCode: 0, stdout: [''] })
    const tmux = new RealTmuxService({ processService: procs })

    await expect(
      tmux.createSession({ socket: SOCKET, session: 'orch', width: 200, height: 50 }),
    ).rejects.toBeInstanceOf(TmuxCommandError)
  })
})
