import { describe, expect, it } from 'bun:test'
import { step } from '../../../src/core/step.ts'
import type { WorkflowDeps } from '../../../src/core/workflow.ts'
import { workflow } from '../../../src/core/workflow.ts'
import { FakeRunner, type RunnerEvent } from '../../../src/runners/index.ts'
import {
  FakeClock,
  FakeFsService,
  FakeGitService,
  FakeProcessService,
  path,
} from '../../../src/services/index.ts'
import { FileStateStore, type RunId } from '../../../src/state/index.ts'

const rid = (s: string): RunId => s as RunId
const BASE = path('/runs')

function makeDeps(overrides?: {
  fs?: FakeFsService
  processService?: FakeProcessService
  clock?: FakeClock
  runId?: RunId
  onEvent?: WorkflowDeps['onEvent']
  onInteractive?: WorkflowDeps['onInteractive']
  tmuxActive?: boolean
}): WorkflowDeps & { processService: FakeProcessService; clock: FakeClock } {
  const fs = overrides?.fs ?? new FakeFsService()
  const processService = overrides?.processService ?? new FakeProcessService()
  const clock = overrides?.clock ?? new FakeClock(1000)
  return {
    fsService: fs,
    gitService: new FakeGitService(),
    processService,
    clock,
    stateStore: new FileStateStore({ fs, basePath: BASE }),
    runId: overrides?.runId ?? rid('r-2026-04-14-twx001'),
    cwd: path('/workspace'),
    onEvent: overrides?.onEvent,
    onInteractive: overrides?.onInteractive,
    tmuxActive: overrides?.tmuxActive,
  }
}

describe('tmuxActive guard for interactive steps', () => {
  it('refuses to run an interactive step when tmuxActive is true', async () => {
    const deps = makeDeps({
      tmuxActive: true,
      onInteractive: async () => ({
        exitCode: 0,
        durationMs: 0,
        sessionId: '00000000-0000-0000-0000-000000000000',
      }),
    })
    const agent = new FakeRunner(deps.processService)
    const STEP = step.define('brainstorm', { agent, mode: 'interactive' })

    const wf = workflow('test', async (run) => {
      await run(STEP)
    })

    let caught: unknown
    try {
      await wf.execute(deps)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain('Interactive step "brainstorm"')
    expect((caught as Error).message).toContain('--tmux')
  })

  it('runs an autonomous step normally while tmuxActive is true', async () => {
    const deps = makeDeps({ tmuxActive: true })
    const agent = new FakeRunner(deps.processService)
    agent.script({ structuredOutput: 'ok' })

    const STEP = step.define('work', { agent })

    let result: unknown
    const wf = workflow('test', async (run) => {
      result = await run(STEP)
    })
    await wf.execute(deps)

    expect(result).toBe('ok')
  })
})

describe('onEvent forwarding to runRunner', () => {
  it('fires the onEvent callback for every parsed runner event in order', async () => {
    const received: RunnerEvent[] = []
    const deps = makeDeps({
      onEvent: (evt) => received.push(evt),
    })
    const agent = new FakeRunner(deps.processService)
    agent.script({
      events: [
        { kind: 'info', type: 'assistant', payload: { text: 'hello' } },
        { kind: 'info', type: 'tool-call', payload: { name: 'Write' } },
      ],
      structuredOutput: 'done',
    })

    const STEP = step.define('work', { agent })

    const wf = workflow('test', async (run) => {
      await run(STEP)
    })
    await wf.execute(deps)

    expect(received.length).toBe(3)
    expect(received[0]).toMatchObject({ kind: 'info', type: 'assistant' })
    expect(received[1]).toMatchObject({ kind: 'info', type: 'tool-call' })
    expect(received[2]).toMatchObject({ kind: 'terminal', type: 'turn-complete' })
  })

  it('runs an autonomous step normally when onEvent is undefined', async () => {
    const deps = makeDeps()
    const agent = new FakeRunner(deps.processService)
    agent.script({ structuredOutput: 'ok' })

    const STEP = step.define('work', { agent })

    let result: unknown
    const wf = workflow('test', async (run) => {
      result = await run(STEP)
    })
    await wf.execute(deps)

    expect(result).toBe('ok')
  })
})
