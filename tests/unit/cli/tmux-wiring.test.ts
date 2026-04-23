import { describe, expect, it } from 'bun:test'
import { Writable } from 'node:stream'
import { ArgvError } from '../../../src/cli/main.ts'
import { setupTmux } from '../../../src/cli/tmux-wiring.ts'
import type { StepLifecycleEvent } from '../../../src/core/index.ts'
import { FakeClock, FakeProcessService } from '../../../src/services/index.ts'
import { FakeTmuxService, paneId } from '../../../src/services/tmux/index.ts'
import type { RunId } from '../../../src/state/index.ts'

const rid = (s: string): RunId => s as RunId

function makeStderrBuffer(): { write: NodeJS.WritableStream['write']; text: () => string } {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk))
      cb()
    },
  })
  return {
    write: stream.write.bind(stream),
    text: () => chunks.join(''),
  }
}

// Bun.which('tmux') is a real syscall; tests that exercise the version probe
// branch require tmux on PATH. Tests that skip the probe are unconditional.
const tmuxInstalled = Bun.which('tmux') !== null

describe('setupTmux version probe', () => {
  it.skipIf(!tmuxInstalled)('rejects tmux older than 3.2', async () => {
    const proc = new FakeProcessService()
    proc.when(['tmux', '-V']).respondWith({ exitCode: 0, stdout: ['tmux 2.9a'] })

    const tmux = new FakeTmuxService()
    tmux.nextPaneId(paneId('%0'))
    tmux.setListPanesResult([])

    const stderr = makeStderrBuffer()

    let caught: unknown
    try {
      await setupTmux({
        processService: proc,
        clock: new FakeClock(0),
        runId: rid('r-2026-04-14-twxv01'),
        workflowName: 'demo',
        observe: false,
        stderr: stderr as unknown as NodeJS.WritableStream,
        tmuxService: tmux,
      })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(ArgvError)
    expect((caught as Error).message).toContain('tmux >= 3.2')
  })
})

describe('setupTmux with skipVersionCheck', () => {
  it('records initOrchSession → listPanes → sendKeys(exec cat) → status render', async () => {
    const proc = new FakeProcessService()
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%7'])
    const stderr = makeStderrBuffer()

    const handles = await setupTmux({
      processService: proc,
      clock: new FakeClock(1000),
      runId: rid('r-2026-04-14-twx001'),
      workflowName: 'demo-flow',
      observe: false,
      stderr: stderr as unknown as NodeJS.WritableStream,
      tmuxService: tmux,
      skipVersionCheck: true,
    })

    const methods = tmux.recordedCalls.map((c) => c.method)
    expect(methods.slice(0, 5)).toEqual([
      'createSession',
      'setOption',
      'setOption',
      'setHook',
      'listPanes',
    ])
    expect(methods).toContain('sendKeys')
    expect(methods).not.toContain('splitPane')

    expect(String(handles.socket)).toBe('orch-r-2026-04-14-twx001')
    expect(handles.onEvent).toBeUndefined()
  })

  it('splits an observe pane when observe is true', async () => {
    const proc = new FakeProcessService()
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%9'))
    const stderr = makeStderrBuffer()

    const handles = await setupTmux({
      processService: proc,
      clock: new FakeClock(0),
      runId: rid('r-2026-04-14-twx002'),
      workflowName: 'demo',
      observe: true,
      stderr: stderr as unknown as NodeJS.WritableStream,
      tmuxService: tmux,
      skipVersionCheck: true,
    })

    const splits = tmux.recordedCalls.filter((c) => c.method === 'splitPane')
    expect(splits.length).toBe(1)
    expect(handles.onEvent).toBeDefined()
  })

  it('writes the attach hint to the supplied stderr', async () => {
    const proc = new FakeProcessService()
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    const stderr = makeStderrBuffer()

    await setupTmux({
      processService: proc,
      clock: new FakeClock(0),
      runId: rid('r-2026-04-14-twx003'),
      workflowName: 'demo',
      observe: false,
      stderr: stderr as unknown as NodeJS.WritableStream,
      tmuxService: tmux,
      skipVersionCheck: true,
    })

    expect(stderr.text()).toContain('tmux -L orch-r-2026-04-14-twx003 attach -t orch')
    expect(stderr.text()).toContain('kill-server')
  })

  it('forwards step lifecycle events as sendKeys to the status pane', async () => {
    const proc = new FakeProcessService()
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%3'])
    const stderr = makeStderrBuffer()

    const handles = await setupTmux({
      processService: proc,
      clock: new FakeClock(10_000),
      runId: rid('r-2026-04-14-twx004'),
      workflowName: 'demo',
      observe: false,
      stderr: stderr as unknown as NodeJS.WritableStream,
      tmuxService: tmux,
      skipVersionCheck: true,
    })

    const priorSendKeys = tmux.recordedCalls.filter((c) => c.method === 'sendKeys').length

    const event: StepLifecycleEvent = {
      type: 'step:start',
      stepName: 'brainstorm' as never,
      mode: 'autonomous',
    }
    handles.onStepEvent(event)

    // Status loop fires async — wait a microtask.
    await new Promise<void>((resolve) => setImmediate(resolve))

    const afterSendKeys = tmux.recordedCalls.filter((c) => c.method === 'sendKeys').length
    expect(afterSendKeys).toBeGreaterThan(priorSendKeys)

    const lastSendKeys = tmux.recordedCalls
      .filter((c) => c.method === 'sendKeys')
      .at(-1) as Extract<(typeof tmux.recordedCalls)[number], { method: 'sendKeys' }>
    expect(lastSendKeys.opts.target).toBe('%3' as never)
    expect(lastSendKeys.opts.keys.join('')).toContain('brainstorm')
  })

  it('teardown stops the loop so later events produce no further sendKeys', async () => {
    const proc = new FakeProcessService()
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%1'])
    const stderr = makeStderrBuffer()

    const handles = await setupTmux({
      processService: proc,
      clock: new FakeClock(0),
      runId: rid('r-2026-04-14-twx005'),
      workflowName: 'demo',
      observe: false,
      stderr: stderr as unknown as NodeJS.WritableStream,
      tmuxService: tmux,
      skipVersionCheck: true,
    })

    await handles.teardown()

    handles.onStepEvent({
      type: 'step:start',
      stepName: 'late' as never,
      mode: 'autonomous',
    })
    await new Promise<void>((resolve) => setImmediate(resolve))

    const sendKeysAfterStop = tmux.recordedCalls.filter(
      (c) => c.method === 'sendKeys' && c.opts.keys.join('').includes('late'),
    )
    expect(sendKeysAfterStop.length).toBe(0)
  })
})
