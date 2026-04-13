import { describe, expect, it } from 'bun:test'
import {
  InteractiveParallelError,
  RunnerCapabilityError,
  StepError,
} from '../../../src/core/errors.ts'
import { currentParallelDepth, executionContext } from '../../../src/core/execution-context.ts'
import { step } from '../../../src/core/step.ts'
import type { InteractiveResult } from '../../../src/core/types.ts'
import type { WorkflowDeps } from '../../../src/core/workflow.ts'
import { workflow } from '../../../src/core/workflow.ts'
import {
  defineRunner,
  FakeRunner,
  type Runner,
  type RunnerContext,
} from '../../../src/runners/index.ts'
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
  generateSessionId?: () => string
  onInteractive?: WorkflowDeps['onInteractive']
  onStepEvent?: WorkflowDeps['onStepEvent']
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
    runId: overrides?.runId ?? rid('r-2026-04-13-int001'),
    cwd: path('/workspace'),
    generateSessionId: overrides?.generateSessionId,
    onInteractive: overrides?.onInteractive,
    onStepEvent: overrides?.onStepEvent,
  }
}

function makeNonInteractiveRunner(): Runner {
  return defineRunner({
    name: 'no-interactive',
    supports: { interactive: false, structuredOutput: false },
    buildCommand(ctx: RunnerContext) {
      return { argv: ['noop'], env: ctx.env }
    },
    parseEvents() {
      return null
    },
    extractStructuredOutput() {
      return undefined
    },
  })
}

describe('interactive mode resolution', () => {
  it('resolves to interactive when step config has mode interactive', async () => {
    const deps = makeDeps({
      generateSessionId: () => '11111111-1111-1111-1111-111111111111',
      onInteractive: async () => ({
        exitCode: 0,
        durationMs: 5000,
        sessionId: '11111111-1111-1111-1111-111111111111',
      }),
    })
    const agent = new FakeRunner(deps.processService)

    const STEP = step.define('brainstorm', { agent, mode: 'interactive' })

    let result: unknown
    const wf = workflow('test', async (run) => {
      result = await run(STEP)
    })
    await wf.execute(deps)

    const ir = result as InteractiveResult
    expect(ir.exitCode).toBe(0)
    expect(ir.sessionId).toBe('11111111-1111-1111-1111-111111111111')
  })

  it('resolves to interactive when override mode is interactive', async () => {
    const deps = makeDeps({
      generateSessionId: () => '22222222-2222-2222-2222-222222222222',
      onInteractive: async () => ({
        exitCode: 0,
        durationMs: 1000,
        sessionId: '22222222-2222-2222-2222-222222222222',
      }),
    })
    const agent = new FakeRunner(deps.processService)

    // Step defined as autonomous, but overridden to interactive
    const STEP = step.define('plan', { agent })

    let result: unknown
    const wf = workflow('test', async (run) => {
      result = await run(STEP, { mode: 'interactive' })
    })
    await wf.execute(deps)

    const ir = result as InteractiveResult
    expect(ir.exitCode).toBe(0)
  })

  it('resolves to autonomous when neither config nor override specifies mode', async () => {
    const deps = makeDeps()
    const agent = new FakeRunner(deps.processService)
    agent.script({ structuredOutput: 'done' })

    const STEP = step.define('work', { agent })

    let result: unknown
    const wf = workflow('test', async (run) => {
      result = await run(STEP)
    })
    await wf.execute(deps)

    expect(result).toBe('done')
  })
})

describe('interactive parallel guard', () => {
  it('throws InteractiveParallelError when interactive step runs inside parallel context', async () => {
    let caught: unknown
    await executionContext.run({ parallelDepth: 1 }, async () => {
      const deps = makeDeps({
        onInteractive: async () => ({
          exitCode: 0,
          durationMs: 100,
          sessionId: '00000000-0000-0000-0000-000000000000',
        }),
      })
      const agent = new FakeRunner(deps.processService)
      const STEP = step.define('brainstorm', { agent, mode: 'interactive' })

      const wf = workflow('test', async (run) => {
        await run(STEP)
      })

      try {
        await wf.execute(deps)
      } catch (err) {
        caught = err
      }
    })

    expect(caught).toBeInstanceOf(InteractiveParallelError)
    expect((caught as InteractiveParallelError).stepName as string).toBe('brainstorm')
  })
})

describe('runner capability guard', () => {
  it('throws RunnerCapabilityError when runner does not support interactive', async () => {
    const deps = makeDeps()
    const agent = makeNonInteractiveRunner()

    const STEP = step.define('brainstorm', {
      agent,
      mode: 'interactive',
    } as Parameters<typeof step.define>[1])

    const wf = workflow('test', async (run) => {
      await run(STEP)
    })

    let caught: unknown
    try {
      await wf.execute(deps)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(RunnerCapabilityError)
    expect((caught as RunnerCapabilityError).runnerName).toBe('no-interactive')
  })
})

describe('interactive step non-zero exit', () => {
  it('throws StepError when interactive session exits non-zero', async () => {
    const deps = makeDeps({
      onInteractive: async () => ({
        exitCode: 130,
        durationMs: 1000,
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

    expect(caught).toBeInstanceOf(StepError)
    const se = caught as StepError
    expect(se.exitCode).toBe(130)
    expect(se.message).toContain('interactive session exited 130')
  })
})

describe('interactive step caching on resume', () => {
  it('caches a completed interactive step and skips it on resume', async () => {
    const sharedFs = new FakeFsService()
    const sharedRunId = rid('r-2026-04-13-ires01')
    let interactiveCalls = 0

    // First run: interactive step succeeds, then next step crashes
    const fps1 = new FakeProcessService()
    const deps1 = makeDeps({
      fs: sharedFs,
      processService: fps1,
      runId: sharedRunId,
      generateSessionId: () => '33333333-3333-3333-3333-333333333333',
      onInteractive: async () => {
        interactiveCalls++
        return {
          exitCode: 0,
          durationMs: 5000,
          sessionId: '33333333-3333-3333-3333-333333333333',
        }
      },
    })
    const agent = new FakeRunner(fps1)
    const fr1 = new FakeRunner(fps1)
    fr1.script({ failWith: { message: 'crash' } })

    const wf = workflow('test', async (run) => {
      await run(step.define('brainstorm', { agent, mode: 'interactive' }))
      await run(step.define('work', { agent: fr1 }))
    })

    try {
      await wf.execute(deps1)
    } catch {
      // expected crash
    }

    expect(interactiveCalls).toBe(1)

    // Resume: interactive step cached, work step succeeds
    const fps2 = new FakeProcessService()
    const fr2 = new FakeRunner(fps2)
    fr2.script({ structuredOutput: 'done' })

    const deps2 = makeDeps({
      fs: sharedFs,
      processService: fps2,
      runId: sharedRunId,
      onInteractive: async () => {
        interactiveCalls++
        return {
          exitCode: 0,
          durationMs: 1000,
          sessionId: '33333333-3333-3333-3333-333333333333',
        }
      },
    })

    const wf2 = workflow('test', async (run) => {
      await run(step.define('brainstorm', { agent: new FakeRunner(fps2), mode: 'interactive' }))
      await run(step.define('work', { agent: fr2 }))
    })
    await wf2.execute(deps2)

    // Interactive step was NOT called again on resume
    expect(interactiveCalls).toBe(1)
  })
})

describe('onStepEvent lifecycle hooks', () => {
  it('emits step:start and step:complete for a successful interactive step', async () => {
    const events: unknown[] = []
    const deps = makeDeps({
      generateSessionId: () => '44444444-4444-4444-4444-444444444444',
      onInteractive: async () => ({
        exitCode: 0,
        durationMs: 2000,
        sessionId: '44444444-4444-4444-4444-444444444444',
      }),
      onStepEvent: (e) => events.push(e),
    })
    const agent = new FakeRunner(deps.processService)
    const STEP = step.define('brainstorm', { agent, mode: 'interactive' })

    const wf = workflow('test', async (run) => {
      await run(STEP)
    })
    await wf.execute(deps)

    expect(events).toEqual([
      { type: 'step:start', stepName: 'brainstorm', mode: 'interactive' },
      { type: 'step:complete', stepName: 'brainstorm', durationMs: 2000 },
    ])
  })

  it('emits step:cached when a step is served from cache', async () => {
    const sharedFs = new FakeFsService()
    const sharedRunId = rid('r-2026-04-13-evtc01')

    // First run — populate cache
    const fps1 = new FakeProcessService()
    const deps1 = makeDeps({ fs: sharedFs, processService: fps1, runId: sharedRunId })
    const fr1 = new FakeRunner(fps1)
    fr1.script({ structuredOutput: 'cached-val' })

    const wf = workflow('test', async (run) => {
      await run(step.define('plan', { agent: fr1 }))
    })
    await wf.execute(deps1)

    // Second run — should hit cache
    const events: unknown[] = []
    const fps2 = new FakeProcessService()
    const deps2 = makeDeps({
      fs: sharedFs,
      processService: fps2,
      runId: sharedRunId,
      onStepEvent: (e) => events.push(e),
    })

    const wf2 = workflow('test', async (run) => {
      await run(step.define('plan', { agent: new FakeRunner(fps2) }))
    })
    await wf2.execute(deps2)

    expect(events).toEqual([{ type: 'step:cached', stepName: 'plan' }])
  })
})

describe('execution-context', () => {
  it('returns 0 when outside any parallel context', () => {
    expect(currentParallelDepth()).toBe(0)
  })

  it('returns the depth set by executionContext.run', async () => {
    let depth = -1
    await executionContext.run({ parallelDepth: 3 }, async () => {
      depth = currentParallelDepth()
    })

    expect(depth).toBe(3)
  })
})
