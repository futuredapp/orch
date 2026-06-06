// Phase B — end-to-end check that resolveView's silent short-circuit reaches
// the host. A two-step FakeRunner workflow with one silent step should show
// only the other step's transcript output on stdout; lifecycle events still
// fire for both (so status rollups see the full timeline in Phase D).

import { describe, expect, it } from 'bun:test'
import { Writable } from 'node:stream'
import { step } from '../../../src/core/step.ts'
import { type WorkflowDeps, workflow } from '../../../src/core/workflow.ts'
import { createPlainHost } from '../../../src/hosts/index.ts'
import { FakeRunner } from '../../../src/runners/index.ts'
import {
  FakeClock,
  FakeFsService,
  FakeGitService,
  FakeProcessService,
  path,
} from '../../../src/services/index.ts'
import { FakePromptService } from '../../../src/services/prompt/index.ts'
import { FileStateStore, type RunId } from '../../../src/state/index.ts'

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

const RUN_ID = 'r-2026-04-23-419108-97' as RunId

describe('view resolution under --mode=plain', () => {
  it('suppresses runner events for silent steps but still fires lifecycle events', async () => {
    const fs = new FakeFsService()
    const processService = new FakeProcessService()
    const clock = new FakeClock(1_700_000_000_000)
    const stdout = bufferStream()
    const stderr = bufferStream()
    const host = createPlainHost({
      stdout: stdout.stream,
      stderr: stderr.stream,
      format: 'text',
      clock,
      runId: RUN_ID,
    })

    const agent = new FakeRunner(processService)
    agent.script({
      events: [{ kind: 'info', type: 'assistant', payload: { text: 'plan-chatter' } }],
      structuredOutput: 'plan-done',
    })
    agent.script({
      events: [{ kind: 'info', type: 'assistant', payload: { text: 'work-chatter' } }],
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

    const wf = workflow('silent-demo', async (run) => {
      await run(step.define('plan', { agent, silent: true }))
      await run(step.define('work', { agent }))
    })

    await wf.execute(deps)
    await host.teardown()

    const lines = stdout
      .text()
      .split('\n')
      .filter((l) => l.length > 0)

    // Lifecycle: both steps show up on stdout via [orch] prefix.
    expect(lines).toContain('[orch] step:start plan (autonomous)')
    expect(lines).toContain('[orch] step:start work (autonomous)')

    // Transcript: only `work` emits a [work] line. No [plan] lines at all.
    expect(lines.some((l) => l.startsWith('[plan] '))).toBe(false)
    expect(lines.some((l) => l.startsWith('[work] '))).toBe(true)
  })

  it('emits runner events for both steps when neither is silent', async () => {
    const fs = new FakeFsService()
    const processService = new FakeProcessService()
    const clock = new FakeClock(1_700_000_000_000)
    const stdout = bufferStream()
    const stderr = bufferStream()
    const host = createPlainHost({
      stdout: stdout.stream,
      stderr: stderr.stream,
      format: 'text',
      clock,
      runId: RUN_ID,
    })

    const agent = new FakeRunner(processService)
    agent.script({
      events: [{ kind: 'info', type: 'assistant', payload: { text: 'plan-chatter' } }],
      structuredOutput: 'plan-done',
    })
    agent.script({
      events: [{ kind: 'info', type: 'assistant', payload: { text: 'work-chatter' } }],
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

    const wf = workflow('noisy-demo', async (run) => {
      await run(step.define('plan', { agent }))
      await run(step.define('work', { agent }))
    })

    await wf.execute(deps)
    await host.teardown()

    const lines = stdout
      .text()
      .split('\n')
      .filter((l) => l.length > 0)

    expect(lines.some((l) => l.startsWith('[plan] '))).toBe(true)
    expect(lines.some((l) => l.startsWith('[work] '))).toBe(true)
  })
})

describe('view resolution error surfacing', () => {
  it('raises ViewResolutionError for an interactive step under --mode=plain when no onInteractive handler is wired', async () => {
    const fs = new FakeFsService()
    const processService = new FakeProcessService()
    const clock = new FakeClock(1_700_000_000_000)
    const stdout = bufferStream()
    const stderr = bufferStream()
    const host = createPlainHost({
      stdout: stdout.stream,
      stderr: stderr.stream,
      format: 'text',
      clock,
      runId: RUN_ID,
    })

    const agent = new FakeRunner(processService)
    // No script needed — resolveView fires before spawn.

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

    const wf = workflow('interactive-plain', async (run) => {
      await run(step.define('brainstorm', { agent, mode: 'interactive' }))
    })

    let caught: unknown
    try {
      await wf.execute(deps)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeDefined()
    expect((caught as Error).name).toBe('ViewResolutionError')
    expect((caught as Error).message).toContain('use --mode=two-pane')
  })
})
