// Integration test — exercises setupTmux end-to-end against a FakeTmuxService
// and drives a real workflow through it so we can verify every step lifecycle
// event reaches the status pane via sendKeys.

import { describe, expect, it } from 'bun:test'
import { Writable } from 'node:stream'
import { setupTmux } from '../../../src/cli/tmux-wiring.ts'
import { step } from '../../../src/core/step.ts'
import { workflow } from '../../../src/core/workflow.ts'
import { FakeRunner } from '../../../src/runners/index.ts'
import {
  FakeClock,
  FakeFsService,
  FakeGitService,
  FakeProcessService,
  path,
} from '../../../src/services/index.ts'
import { FakeTmuxService, paneId } from '../../../src/services/tmux/index.ts'
import { FileStateStore, type RunId } from '../../../src/state/index.ts'

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

describe('setupTmux + workflow integration', () => {
  it('renders both step names into sendKeys payloads for a two-step workflow', async () => {
    const processService = new FakeProcessService()
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%2'])
    const clock = new FakeClock(0)
    const stderr = makeStderrBuffer()
    const runId = rid('r-2026-04-14-twxi01')

    const handles = await setupTmux({
      processService,
      clock,
      runId,
      workflowName: 'demo',
      observe: false,
      stderr: stderr as unknown as NodeJS.WritableStream,
      tmuxService: tmux,
      skipVersionCheck: true,
    })

    const fs = new FakeFsService()
    const agent = new FakeRunner(processService)
    agent.script({ structuredOutput: 'a-done' })
    agent.script({ structuredOutput: 'b-done' })

    const wf = workflow('demo', async (run) => {
      await run(step.define('plan', { agent }))
      await run(step.define('work', { agent }))
    })

    await wf.execute({
      stateStore: new FileStateStore({ fs, basePath: path('/runs') }),
      processService,
      clock,
      runId,
      cwd: path('/workspace'),
      fsService: fs,
      gitService: new FakeGitService(),
      workflowName: 'demo',
      onStepEvent: handles.onStepEvent,
      tmuxActive: true,
    })

    // Give the fire-and-forget status-loop a tick to drain.
    await new Promise<void>((resolve) => setImmediate(resolve))

    await handles.teardown()

    const sendKeysPayloads = tmux.recordedCalls
      .filter(
        (c): c is Extract<(typeof tmux.recordedCalls)[number], { method: 'sendKeys' }> =>
          c.method === 'sendKeys',
      )
      .map((c) => c.opts.keys.join(''))
      .join('\n')

    expect(sendKeysPayloads).toContain('plan')
    expect(sendKeysPayloads).toContain('work')
    expect(stderr.text()).toContain('tmux -L orch-r-2026-04-14-twxi01 attach')
  })

  it('routes runner events to the observe pane when observe is enabled', async () => {
    const processService = new FakeProcessService()
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%5'])
    tmux.nextPaneId(paneId('%6'))
    const clock = new FakeClock(0)
    const stderr = makeStderrBuffer()
    const runId = rid('r-2026-04-14-twxi02')

    const handles = await setupTmux({
      processService,
      clock,
      runId,
      workflowName: 'demo',
      observe: true,
      stderr: stderr as unknown as NodeJS.WritableStream,
      tmuxService: tmux,
      skipVersionCheck: true,
    })

    const fs = new FakeFsService()
    const agent = new FakeRunner(processService)
    agent.script({
      events: [{ kind: 'info', type: 'assistant', payload: { text: 'hi' } }],
      structuredOutput: 'ok',
    })

    const wf = workflow('demo', async (run) => {
      await run(step.define('work', { agent }))
    })

    await wf.execute({
      stateStore: new FileStateStore({ fs, basePath: path('/runs') }),
      processService,
      clock,
      runId,
      cwd: path('/workspace'),
      fsService: fs,
      gitService: new FakeGitService(),
      workflowName: 'demo',
      onStepEvent: handles.onStepEvent,
      ...(handles.onEvent !== undefined ? { onEvent: handles.onEvent } : {}),
      tmuxActive: true,
    })

    await new Promise<void>((resolve) => setImmediate(resolve))
    await handles.teardown()

    const observeSendKeys = tmux.recordedCalls.filter(
      (c): c is Extract<(typeof tmux.recordedCalls)[number], { method: 'sendKeys' }> =>
        c.method === 'sendKeys' && c.opts.target === ('%6' as never),
    )
    const observeText = observeSendKeys.map((c) => c.opts.keys.join('')).join('\n')

    expect(observeText).toContain('info:assistant')
    expect(observeText).toContain('terminal:turn-complete')
  })
})
