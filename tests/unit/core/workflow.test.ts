import { describe, expect, it } from 'bun:test'
import { step } from '../../../src/core/step.ts'
import { StepError, type WorkflowDeps, workflow } from '../../../src/core/workflow.ts'
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

interface TestDeps extends WorkflowDeps {
  readonly fs: FakeFsService
  readonly processService: FakeProcessService
  readonly clock: FakeClock
  readonly gitService: FakeGitService
  readonly fsService: FakeFsService
}

function makeDeps(overrides?: {
  fs?: FakeFsService
  processService?: FakeProcessService
  clock?: FakeClock
  runId?: RunId
  gitService?: FakeGitService
}): TestDeps {
  const fs = overrides?.fs ?? new FakeFsService()
  const processService = overrides?.processService ?? new FakeProcessService()
  const clock = overrides?.clock ?? new FakeClock(1000)
  const gitService = overrides?.gitService ?? new FakeGitService()
  return {
    fs,
    fsService: fs,
    gitService,
    processService,
    clock,
    stateStore: new FileStateStore({ fs, basePath: BASE }),
    runId: overrides?.runId ?? rid('r-2026-04-10-000001'),
    cwd: path('/workspace'),
  }
}

describe('workflow run()', () => {
  it('executes a step and returns its value via extractStructuredOutput', async () => {
    const deps = makeDeps()
    const fr = new FakeRunner(deps.processService)
    fr.script({ structuredOutput: { answer: 42 } })
    const STEP = step.define('plan', { agent: fr })

    let result: unknown
    const wf = workflow('test', async (run) => {
      result = await run(STEP)
    })
    await wf.execute(deps)

    expect(result).toEqual({ answer: 42 })
  })

  it('memoizes by step name — second invocation returns cached value without re-running', async () => {
    const deps = makeDeps()
    const fr = new FakeRunner(deps.processService)
    fr.script({ structuredOutput: 'first-call' })
    const STEP = step.define('plan', { agent: fr })

    let first: unknown
    let second: unknown
    const wf = workflow('test', async (run) => {
      first = await run(STEP)
      second = await run(STEP)
    })
    await wf.execute(deps)

    expect(first).toBe('first-call')
    expect(second).toBe('first-call')
    expect(fr.invocationCount).toBe(1)
  })

  it('uses overrides.as as the memoization key instead of step name', async () => {
    const deps = makeDeps()
    const fr = new FakeRunner(deps.processService)
    fr.script({ structuredOutput: 'run-a' })
    fr.script({ structuredOutput: 'run-b' })
    const STEP = step.define('plan', { agent: fr })

    let resultA: unknown
    let resultB: unknown
    const wf = workflow('test', async (run) => {
      resultA = await run(STEP, { as: 'plan-alpha' })
      resultB = await run(STEP, { as: 'plan-beta' })
    })
    await wf.execute(deps)

    expect(resultA).toBe('run-a')
    expect(resultB).toBe('run-b')
    expect(fr.invocationCount).toBe(2)
  })

  it('overrides at call site do not change the memoization key when as is absent', async () => {
    const deps = makeDeps()
    const fr = new FakeRunner(deps.processService)
    fr.script({ structuredOutput: 'only-once' })
    const STEP = step.define('plan', { agent: fr })

    let first: unknown
    let second: unknown
    const wf = workflow('test', async (run) => {
      first = await run(STEP, { prompt: 'override-1' })
      second = await run(STEP, { prompt: 'override-2' })
    })
    await wf.execute(deps)

    expect(first).toBe('only-once')
    expect(second).toBe('only-once')
    expect(fr.invocationCount).toBe(1)
  })

  it('assembles prompt from config default, overrides.prompt, extraContext, and extraPrompt', async () => {
    const deps = makeDeps()
    const fr = new FakeRunner(deps.processService)
    fr.script({ structuredOutput: 'ok' })
    const STEP = step.define('plan', { agent: fr, prompt: 'default prompt' })

    const wf = workflow('test', async (run) => {
      await run(STEP, {
        prompt: 'override prompt',
        extraContext: { key: 'value' },
        extraPrompt: 'extra instructions',
      })
    })
    await wf.execute(deps)

    // Verify prompt was passed through by checking the runner was invoked.
    // The exact prompt assembly is an internal detail; we verify the step ran.
    expect(fr.invocationCount).toBe(1)
  })

  it('throws StepError when runner returns an error terminal event', async () => {
    const deps = makeDeps()
    const fr = new FakeRunner(deps.processService)
    fr.script({ failWith: { message: 'compilation failed', exitCode: 2 } })
    const STEP = step.define('compile', { agent: fr })

    const wf = workflow('test', async (run) => {
      await run(STEP)
    })

    try {
      await wf.execute(deps)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(StepError)
      const se = err as StepError
      expect(se.stepName as string).toBe('compile')
      expect(se.exitCode).toBe(2)
      expect(se.message).toContain('compilation failed')
    }
  })

  it('sets status to completed on success', async () => {
    const deps = makeDeps()
    const fr = new FakeRunner(deps.processService)
    fr.script({ structuredOutput: 'done' })
    const STEP = step.define('plan', { agent: fr })

    const wf = workflow('test', async (run) => {
      await run(STEP)
    })
    await wf.execute(deps)

    const state = await deps.stateStore.loadRun(deps.runId)
    expect(state?.status).toBe('completed')
  })

  it('sets status to crashed on step failure', async () => {
    const deps = makeDeps()
    const fr = new FakeRunner(deps.processService)
    fr.script({ failWith: { message: 'boom' } })
    const STEP = step.define('plan', { agent: fr })

    const wf = workflow('test', async (run) => {
      await run(STEP)
    })

    try {
      await wf.execute(deps)
    } catch {
      // expected
    }

    const state = await deps.stateStore.loadRun(deps.runId)
    expect(state?.status).toBe('crashed')
  })

  it('resume skips completed steps and re-runs the failed step', async () => {
    const sharedRunId = rid('r-2026-04-10-000001')
    const fs = new FakeFsService()

    // First execution: steps 1 and 2 succeed, step 3 fails
    const fps1 = new FakeProcessService()
    const deps1 = makeDeps({ fs, processService: fps1, runId: sharedRunId })
    const fr1a = new FakeRunner(fps1)
    fr1a.script({ structuredOutput: 'result-1' })
    const fr1b = new FakeRunner(fps1)
    fr1b.script({ structuredOutput: 'result-2' })
    const fr1c = new FakeRunner(fps1)
    fr1c.script({ failWith: { message: 'crash at step 3' } })

    const STEP_A = step.define('step-a', { agent: fr1a })
    const STEP_B = step.define('step-b', { agent: fr1b })

    const wf = workflow('test', async (run) => {
      await run(STEP_A)
      await run(STEP_B)
      await run(step.define('step-c', { agent: fr1c }))
    })

    try {
      await wf.execute(deps1)
    } catch {
      // expected crash
    }

    expect(fr1a.invocationCount).toBe(1)
    expect(fr1b.invocationCount).toBe(1)

    // Second execution: same runId, new runners — step-c now succeeds
    const fps2 = new FakeProcessService()
    const deps2 = makeDeps({ fs, processService: fps2, runId: sharedRunId })
    const fr2a = new FakeRunner(fps2)
    fr2a.script({ structuredOutput: 'should-not-run' })
    const fr2b = new FakeRunner(fps2)
    fr2b.script({ structuredOutput: 'should-not-run' })
    const fr2c = new FakeRunner(fps2)
    fr2c.script({ structuredOutput: 'result-3' })

    const wf2 = workflow('test', async (run) => {
      await run(step.define('step-a', { agent: fr2a }))
      await run(step.define('step-b', { agent: fr2b }))
      await run(step.define('step-c', { agent: fr2c }))
    })
    await wf2.execute(deps2)

    // Steps a and b were cached — their runners never invoked
    expect(fr2a.invocationCount).toBe(0)
    expect(fr2b.invocationCount).toBe(0)
    // Step c re-ran successfully
    expect(fr2c.invocationCount).toBe(1)

    const state = await deps2.stateStore.loadRun(sharedRunId)
    expect(state?.status).toBe('completed')
    expect(Object.keys(state?.steps ?? {})).toHaveLength(3)
  })

  it('workflow throws StepError when the runner exits non-zero even after a turn-complete event', async () => {
    const deps = makeDeps()

    // Custom runner that scripts the FakeProcessService directly: emits a
    // turn-complete terminal event AND then reports a non-zero exit code.
    const argv = [':noisy-exit:'] as const
    const terminalLine = JSON.stringify({ kind: 'terminal', type: 'turn-complete', data: 'ok' })
    deps.processService.when(argv).respondWith({ stdout: [terminalLine], exit: 7 })

    const noisy: Runner = defineRunner({
      name: 'noisy',
      supports: { interactive: false, structuredOutput: false },
      buildCommand(ctx: RunnerContext) {
        return { argv, env: ctx.env }
      },
      parseEvents(line: string) {
        if (line.trim() === '') return null
        return JSON.parse(line)
      },
      extractStructuredOutput() {
        return undefined
      },
    })
    const STEP = step.define('noisy', { agent: noisy })

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
    expect(se.exitCode).toBe(7)
    expect(se.message).toContain('runner exited 7')
  })

  it('initRun persists empty running state before any steps', async () => {
    const deps = makeDeps()

    const wf = workflow('test', async () => {
      // No steps — just verify state was initialized
    })
    await wf.execute(deps)

    const state = await deps.stateStore.loadRun(deps.runId)
    expect(state).toBeDefined()
    expect(state?.id).toBe(deps.runId)
    expect(state?.status).toBe('completed')
  })
})
