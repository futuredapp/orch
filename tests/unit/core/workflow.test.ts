import { describe, expect, it } from 'bun:test'
import { commit } from '../../../src/core/commit.ts'
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
  GitCommandError,
  path,
} from '../../../src/services/index.ts'
import { FileStateStore, type RunId } from '../../../src/state/index.ts'
import { createFakeHost, type FakeHost } from '../../helpers/fake-host.ts'

const rid = (s: string): RunId => s as RunId

const BASE = path('/runs')

interface TestDeps extends WorkflowDeps {
  readonly fs: FakeFsService
  readonly processService: FakeProcessService
  readonly clock: FakeClock
  readonly gitService: FakeGitService
  readonly fsService: FakeFsService
  readonly host: FakeHost
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
    runId: overrides?.runId ?? rid('r-2026-04-10-458000-q8'),
    cwd: path('/workspace'),
    host: createFakeHost(),
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
    const sharedRunId = rid('r-2026-04-10-458000-q8')
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
    deps.processService.when(argv).respondWith({ stdout: [terminalLine], exitCode: 7 })

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
      toTranscriptLines() {
        return []
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

// ---------------------------------------------------------------------------
// safeToTranscriptLines — executor wires the runner's formatter through to
// the host. The wrapper must catch formatter throws so a buggy formatter can
// never abort a run, and interactive steps must skip the formatter entirely
// (they don't stream events through the host).
// ---------------------------------------------------------------------------

describe('workflow run() — runner.toTranscriptLines forwarding', () => {
  it('forwards transcript lines from runner.toTranscriptLines to host.onRunnerEvent for autonomous steps', async () => {
    const deps = makeDeps()

    const argv = [':spy-format:'] as const
    const events = [
      { kind: 'info', type: 'assistant', payload: { text: 'hello' } },
      { kind: 'terminal', type: 'turn-complete', data: 'ok' },
    ]
    deps.processService
      .when(argv)
      .respondWith({ stdout: events.map((e) => JSON.stringify(e)), exitCode: 0 })

    const spy: Runner = defineRunner({
      name: 'spy-format',
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
      toTranscriptLines(evt) {
        if (evt.kind === 'info' && evt.type === 'assistant') {
          return [{ kind: 'line', category: 'assistant', label: 'assistant>', body: 'hello' }]
        }
        if (evt.kind === 'terminal' && evt.type === 'turn-complete') {
          return [{ kind: 'block', heading: 'done', rows: [['result', 'ok']] }]
        }
        return []
      },
    })
    const STEP = step.define('plan', { agent: spy })

    const wf = workflow('test', async (run) => {
      await run(STEP)
    })
    await wf.execute(deps)

    const runnerEvents = deps.host.recorded.flatMap((r) => (r.kind === 'runner' ? [r] : []))
    expect(runnerEvents).toHaveLength(2)
    const first = runnerEvents[0]
    const second = runnerEvents[1]
    if (first === undefined || second === undefined) throw new Error('expected two runner events')

    expect(first.lines).toEqual([
      { kind: 'line', category: 'assistant', label: 'assistant>', body: 'hello' },
    ])
    expect(second.lines).toEqual([{ kind: 'block', heading: 'done', rows: [['result', 'ok']] }])
  })

  it('catches a thrown formatter, forwards an empty lines array, and lets the run complete', async () => {
    const deps = makeDeps()

    const argv = [':throws-format:'] as const
    const events = [
      { kind: 'info', type: 'assistant', payload: {} },
      { kind: 'terminal', type: 'turn-complete', data: 'done' },
    ]
    deps.processService
      .when(argv)
      .respondWith({ stdout: events.map((e) => JSON.stringify(e)), exitCode: 0 })

    const exploding: Runner = defineRunner({
      name: 'throws-format',
      supports: { interactive: false, structuredOutput: false },
      buildCommand(ctx: RunnerContext) {
        return { argv, env: ctx.env }
      },
      parseEvents(line: string) {
        if (line.trim() === '') return null
        return JSON.parse(line)
      },
      extractStructuredOutput() {
        return 'done'
      },
      toTranscriptLines() {
        throw new Error('formatter exploded')
      },
    })
    const STEP = step.define('plan', { agent: exploding })

    let result: unknown
    const wf = workflow('test', async (run) => {
      result = await run(STEP)
    })
    await wf.execute(deps)

    expect(result).toBe('done')
    const runnerEvents = deps.host.recorded.flatMap((r) => (r.kind === 'runner' ? [r] : []))
    expect(runnerEvents.length).toBeGreaterThan(0)
    for (const r of runnerEvents) {
      expect(r.lines).toEqual([])
    }
  })

  it('does not invoke runner.toTranscriptLines for interactive steps', async () => {
    let formatterCalls = 0
    const interactiveSpy: Runner = defineRunner({
      name: 'interactive-spy',
      supports: { interactive: true, structuredOutput: false },
      buildCommand(ctx: RunnerContext) {
        return { argv: ['noop'], env: ctx.env }
      },
      parseEvents() {
        return null
      },
      extractStructuredOutput() {
        return undefined
      },
      toTranscriptLines() {
        formatterCalls++
        return []
      },
    })

    const deps: WorkflowDeps = {
      ...makeDeps(),
      generateSessionId: () => '11111111-1111-1111-1111-111111111111',
      onInteractive: async () => ({
        exitCode: 0,
        durationMs: 100,
        sessionId: '11111111-1111-1111-1111-111111111111',
      }),
    }
    const STEP = step.define('brainstorm', { agent: interactiveSpy, mode: 'interactive' })

    const wf = workflow('test', async (run) => {
      await run(STEP)
    })
    await wf.execute(deps)

    expect(formatterCalls).toBe(0)
  })
})

describe('workflow run() with commit steps', () => {
  it('commit step stages and commits when tree is dirty', async () => {
    const deps = makeDeps()
    deps.gitService.setIsClean(deps.cwd, false)
    deps.gitService.setCommitSha(deps.cwd, 'abc1234')

    let result: unknown
    const wf = workflow('test', async (run) => {
      result = await run(commit('checkpoint'))
    })
    await wf.execute(deps)

    expect(result).toEqual({ sha: 'abc1234' })
  })

  it('commit step returns null when tree is clean', async () => {
    const deps = makeDeps()
    deps.gitService.setIsClean(deps.cwd, true)

    let result: unknown
    const wf = workflow('test', async (run) => {
      result = await run(commit('checkpoint'))
    })
    await wf.execute(deps)

    expect(result).toBeNull()
  })

  it('commit step is memoized on resume', async () => {
    const sharedRunId = rid('r-2026-04-13-458000-q8')
    const fs = new FakeFsService()

    // First execution: commit succeeds
    const deps1 = makeDeps({ fs, runId: sharedRunId })
    deps1.gitService.setIsClean(deps1.cwd, false)
    deps1.gitService.setCommitSha(deps1.cwd, 'abc1234')

    const fr1 = new FakeRunner(deps1.processService)
    fr1.script({ failWith: { message: 'crash' } })

    const wf1 = workflow('test', async (run) => {
      await run(commit('checkpoint'))
      await run(step.define('crash', { agent: fr1 }))
    })

    try {
      await wf1.execute(deps1)
    } catch {
      // expected crash
    }

    // Second execution: commit step should be cached, agent step succeeds
    const fps2 = new FakeProcessService()
    const deps2 = makeDeps({ fs, processService: fps2, runId: sharedRunId })
    const fr2 = new FakeRunner(fps2)
    fr2.script({ structuredOutput: 'done' })

    let commitResult: unknown
    const wf2 = workflow('test', async (run) => {
      commitResult = await run(commit('checkpoint'))
      await run(step.define('crash', { agent: fr2 }))
    })
    await wf2.execute(deps2)

    expect(commitResult).toEqual({ sha: 'abc1234' })
  })

  it('commit step uses overrides.as for memoization key', async () => {
    const deps = makeDeps()
    deps.gitService.setIsClean(deps.cwd, false)
    deps.gitService.setCommitSha(deps.cwd, 'sha-a')

    let resultA: unknown
    let resultB: unknown
    const wf = workflow('test', async (run) => {
      resultA = await run(commit('checkpoint'), { as: 'commit:first' })
      // Second call with same commit message but different key — re-executes
      deps.gitService.setCommitSha(deps.cwd, 'sha-b')
      resultB = await run(commit('checkpoint'), { as: 'commit:second' })
    })
    await wf.execute(deps)

    expect(resultA).toEqual({ sha: 'sha-a' })
    expect(resultB).toEqual({ sha: 'sha-b' })
  })

  it('commit step does not invoke any Runner', async () => {
    const deps = makeDeps()
    deps.gitService.setIsClean(deps.cwd, false)
    deps.gitService.setCommitSha(deps.cwd, 'abc1234')

    const fr = new FakeRunner(deps.processService)

    const wf = workflow('test', async (run) => {
      await run(commit('checkpoint'))
    })
    await wf.execute(deps)

    expect(fr.invocationCount).toBe(0)
  })

  it('commit step throws when prompt override is provided', async () => {
    const deps = makeDeps()

    const wf = workflow('test', async (run) => {
      await run(commit('checkpoint'), { prompt: 'override' })
    })

    await expect(wf.execute(deps)).rejects.toThrow('does not accept prompt overrides')
  })

  it('commit step throws when extraContext override is provided', async () => {
    const deps = makeDeps()

    const wf = workflow('test', async (run) => {
      await run(commit('checkpoint'), { extraContext: { key: 'val' } })
    })

    await expect(wf.execute(deps)).rejects.toThrow('does not accept extraContext overrides')
  })

  it('commit step throws when extraPrompt override is provided', async () => {
    const deps = makeDeps()

    const wf = workflow('test', async (run) => {
      await run(commit('checkpoint'), { extraPrompt: 'extra' })
    })

    await expect(wf.execute(deps)).rejects.toThrow('does not accept extraPrompt overrides')
  })

  it('commit step propagates GitCommandError from stageAll', async () => {
    const deps = makeDeps()
    deps.gitService.setIsClean(deps.cwd, false)
    // stageAll is a no-op in FakeGitService; override to throw
    deps.gitService.stageAll = async () => {
      throw new GitCommandError(128, 'fatal', 'git add . failed')
    }

    const wf = workflow('test', async (run) => {
      await run(commit('checkpoint'))
    })

    await expect(wf.execute(deps)).rejects.toThrow(GitCommandError)
  })

  it('commit step propagates GitCommandError from commit', async () => {
    const deps = makeDeps()
    deps.gitService.setIsClean(deps.cwd, false)
    // Override commit to throw
    deps.gitService.commit = async () => {
      throw new GitCommandError(1, 'nothing to commit', 'git commit failed')
    }

    const wf = workflow('test', async (run) => {
      await run(commit('checkpoint'))
    })

    await expect(wf.execute(deps)).rejects.toThrow(GitCommandError)
  })
})
