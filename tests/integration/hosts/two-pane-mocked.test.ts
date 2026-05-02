// two-pane-mocked: drive a two-step FakeRunner workflow through the TmuxHost
// backed by FakeTmuxService. Asserts the recorded tmux command stream never
// contains raw JSON on the right pane and that status frames land on the left.

import { describe, expect, it } from 'bun:test'
import { Writable } from 'node:stream'
import { step } from '../../../src/core/step.ts'
import { type WorkflowDeps, workflow } from '../../../src/core/workflow.ts'
import { createTmuxHost, stripAnsi } from '../../../src/hosts/index.ts'
import { createFileSessionLogger } from '../../../src/observability/index.ts'
import { FakeRunner } from '../../../src/runners/index.ts'
import {
  FakeClock,
  FakeFsService,
  FakeGitService,
  FakeProcessService,
  path,
} from '../../../src/services/index.ts'
import { FakePromptService } from '../../../src/services/prompt/index.ts'
import { FakeTmuxService, paneId } from '../../../src/services/tmux/index.ts'
import { FileStateStore, type RunId, runId as runIdFactory } from '../../../src/state/index.ts'

function bufferStream(): { stream: NodeJS.WritableStream; text: () => string } {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk))
      cb()
    },
  })
  return { stream: stream as unknown as NodeJS.WritableStream, text: () => chunks.join('') }
}

const RUN_ID = 'r-2026-04-23-489539-t7' as RunId

describe('two-pane mocked workflow', () => {
  it('streams readable transcript lines on the right pane — no raw JSON anywhere', async () => {
    const fs = new FakeFsService()
    const processService = new FakeProcessService()
    const clock = new FakeClock(1_700_000_000_000)
    const stderr = bufferStream()

    // Left pane is %0 (initial shell), right is %7 (split target).
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%7'))

    const host = await createTmuxHost({
      tmux,
      processService,
      clock,
      runId: RUN_ID,
      workflowName: 'demo',
      stderr: stderr.stream,
      skipVersionCheck: true,
    })

    const agent = new FakeRunner(processService)
    agent.script({
      events: [{ kind: 'info', type: 'assistant', payload: { text: 'plan thinking' } }],
      structuredOutput: 'plan-done',
    })
    agent.script({
      events: [{ kind: 'info', type: 'assistant', payload: { text: 'work thinking' } }],
      structuredOutput: 'work-done',
    })

    const deps: WorkflowDeps = {
      stateStore: new FileStateStore({ fs, basePath: path('/runs') }),
      processService,
      clock,
      runId: RUN_ID,
      cwd: path('/workspace'),
      fsService: fs,
      gitService: new FakeGitService(),
      host,
      promptService: new FakePromptService(),
      interactivity: 'interactive' as const,
    }

    await workflow('demo', async (run) => {
      await run(step.define('plan', { agent }))
      await run(step.define('work', { agent }))
    }).execute(deps)
    await host.teardown()

    // Assert right-pane writes are human-readable transcript lines, never raw JSON.
    const rightWrites = tmux.recordedCalls.filter(
      (c) => c.method === 'sendKeys' && c.opts.target === paneId('%7'),
    )
    expect(rightWrites.length).toBeGreaterThan(0)
    for (const call of rightWrites) {
      if (call.method !== 'sendKeys') continue
      const payload = call.opts.keys.join('')
      expect(payload).not.toMatch(/runnerEvent:/)
      expect(payload).not.toMatch(/"kind":\s*"info"/)
    }

    const anyPayload = stripAnsi(
      rightWrites.map((c) => (c.method === 'sendKeys' ? c.opts.keys.join('') : '')).join(''),
    )
    expect(anyPayload).toContain('[plan] assistant> plan thinking')
    expect(anyPayload).toContain('[work] assistant> work thinking')
  })

  it('left pane receives the status-view rollup (not transcript lines)', async () => {
    const fs = new FakeFsService()
    const processService = new FakeProcessService()
    const clock = new FakeClock(1_700_000_000_000)
    const stderr = bufferStream()

    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%7'))

    const host = await createTmuxHost({
      tmux,
      processService,
      clock,
      runId: RUN_ID,
      workflowName: 'demo',
      stderr: stderr.stream,
      skipVersionCheck: true,
    })

    const agent = new FakeRunner(processService)
    agent.script({ structuredOutput: 'plan-done' })

    const deps: WorkflowDeps = {
      stateStore: new FileStateStore({ fs, basePath: path('/runs') }),
      processService,
      clock,
      runId: RUN_ID,
      cwd: path('/workspace'),
      fsService: fs,
      gitService: new FakeGitService(),
      host,
      promptService: new FakePromptService(),
      interactivity: 'interactive' as const,
    }

    await workflow('demo', async (run) => {
      await run(step.define('plan', { agent }))
    }).execute(deps)
    await host.teardown()

    const leftWrites = tmux.recordedCalls.filter(
      (c) => c.method === 'sendKeys' && c.opts.target === paneId('%0'),
    )
    // First write is `clear && exec cat`; subsequent writes are the status
    // rollup. Every rollup write must contain the workflow title and the
    // step name — never a runner-event line.
    const rollupWrites = leftWrites
      .slice(1)
      .map((c) => (c.method === 'sendKeys' ? c.opts.keys.join('') : ''))
    expect(rollupWrites.length).toBeGreaterThan(0)
    const combined = rollupWrites.join('\n')
    expect(combined).toContain('demo')
    expect(combined).toContain('plan')
    expect(combined).not.toMatch(/assistant>/)
  })

  it('persists rendered transcript bytes to agents/<step>/formatted_output.{ansi,txt}', async () => {
    const fs = new FakeFsService()
    const processService = new FakeProcessService()
    const clock = new FakeClock(1_700_000_000_000)
    const stderr = bufferStream()
    const basePath = path('/state')
    const teeRunId = runIdFactory('r-2026-04-28-000001-tp')

    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%7'))

    const logger = createFileSessionLogger({
      fs,
      clock,
      runId: teeRunId,
      basePath,
      debug: false,
    })

    const host = await createTmuxHost({
      tmux,
      processService,
      clock,
      runId: teeRunId,
      workflowName: 'demo',
      stderr: stderr.stream,
      skipVersionCheck: true,
      logger,
    })

    const agent = new FakeRunner(processService)
    agent.script({
      events: [{ kind: 'info', type: 'assistant', payload: { text: 'plan thinking' } }],
      structuredOutput: 'plan-done',
    })

    const deps: WorkflowDeps = {
      stateStore: new FileStateStore({ fs, basePath }),
      processService,
      clock,
      runId: teeRunId,
      cwd: path('/workspace'),
      fsService: fs,
      gitService: new FakeGitService(),
      host,
      promptService: new FakePromptService(),
      interactivity: 'interactive' as const,
      logger,
    }

    await workflow('demo', async (run) => {
      await run(step.define('plan', { agent }))
    }).execute(deps)
    await host.teardown()
    await logger.close()

    const ansi = await fs.readFile(
      path(`${basePath}/${teeRunId}/logs/agents/plan/formatted_output.ansi`),
    )
    const txt = await fs.readFile(
      path(`${basePath}/${teeRunId}/logs/agents/plan/formatted_output.txt`),
    )

    // tmux always renders with color so ANSI carries escapes; stripping
    // gives the same bytes as the txt sibling.
    expect(stripAnsi(ansi)).toBe(txt)
    expect(txt).toContain('[plan]')
    expect(txt).toContain('plan thinking')
    // tmux uses CRLF line endings on the right pane; the per-step file
    // mirrors the bytes the host emitted.
    expect(ansi).toContain('\r\n')

    // Cross-check: the tee bytes match the right-pane sendKeys payloads.
    const rightPayloads = tmux.recordedCalls
      .filter((c) => c.method === 'sendKeys' && c.opts.target === paneId('%7'))
      .map((c) => (c.method === 'sendKeys' ? c.opts.keys.join('') : ''))
      .join('')
    expect(ansi).toBe(rightPayloads)
  })
})
