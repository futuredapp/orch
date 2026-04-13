import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import { commit } from '../../../src/core/commit.ts'
import { ResumeError, RunNotFoundError } from '../../../src/core/errors.ts'
import { ParallelError, parallel } from '../../../src/core/parallel.ts'
import { step } from '../../../src/core/step.ts'
import { StepError, type WorkflowDeps, workflow } from '../../../src/core/workflow.ts'
import { FakeRunner } from '../../../src/runners/index.ts'
import {
  BunFsService,
  FakeClock,
  FakeGitService,
  FakeProcessService,
  path,
} from '../../../src/services/index.ts'
import { FileStateStore, type RunId } from '../../../src/state/index.ts'

let tmpDir: string

afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

function makeDeps(overrides?: {
  processService?: FakeProcessService
  gitService?: FakeGitService
  runId?: RunId
}): WorkflowDeps & {
  processService: FakeProcessService
  gitService: FakeGitService
  clock: FakeClock
} {
  const processService = overrides?.processService ?? new FakeProcessService()
  const clock = new FakeClock(1000)
  const bunFs = new BunFsService()
  const gitService = overrides?.gitService ?? new FakeGitService()
  return {
    processService,
    clock,
    fsService: bunFs,
    gitService,
    stateStore: new FileStateStore({ fs: bunFs, basePath: path(tmpDir) }),
    runId: overrides?.runId ?? ('r-2026-04-13-res001' as RunId),
    cwd: path('/workspace'),
  }
}

describe('resume (integration)', () => {
  it('four-step crash at step 3, resume completes all steps with memoization', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-resume-test-')
    const sharedRunId = 'r-2026-04-13-res001' as RunId

    // First run: steps A+B succeed, step C crashes
    const fps1 = new FakeProcessService()
    const deps1 = makeDeps({ processService: fps1, runId: sharedRunId })

    const fr1a = new FakeRunner(fps1)
    fr1a.script({ structuredOutput: 'a' })
    const fr1b = new FakeRunner(fps1)
    fr1b.script({ structuredOutput: 'b' })
    const fr1c = new FakeRunner(fps1)
    fr1c.script({ failWith: { message: 'step 3 crash' } })
    const fr1d = new FakeRunner(fps1)
    fr1d.script({ structuredOutput: 'should-not-reach' })

    const buildWf = (frA: FakeRunner, frB: FakeRunner, frC: FakeRunner, frD: FakeRunner) =>
      workflow('four-step', async (run) => {
        await run(step.define('step-a', { agent: frA }))
        await run(step.define('step-b', { agent: frB }))
        await run(step.define('step-c', { agent: frC }))
        await run(step.define('step-d', { agent: frD }))
      })

    try {
      await buildWf(fr1a, fr1b, fr1c, fr1d).execute(deps1)
    } catch (err) {
      expect(err).toBeInstanceOf(StepError)
    }

    // Verify crashed state
    const raw1 = await fs.readFile(`${tmpDir}/${sharedRunId}/state.json`, 'utf-8')
    const crashedState = JSON.parse(raw1)
    expect(crashedState.status).toBe('crashed')
    expect(Object.keys(crashedState.steps)).toHaveLength(2)

    // Resume: A+B cached, C+D run fresh
    const fps2 = new FakeProcessService()
    const deps2 = makeDeps({ processService: fps2, runId: sharedRunId })

    const fr2a = new FakeRunner(fps2)
    fr2a.script({ structuredOutput: 'never' })
    const fr2b = new FakeRunner(fps2)
    fr2b.script({ structuredOutput: 'never' })
    const fr2c = new FakeRunner(fps2)
    fr2c.script({ structuredOutput: 'c-resumed' })
    const fr2d = new FakeRunner(fps2)
    fr2d.script({ structuredOutput: 'd-resumed' })

    await buildWf(fr2a, fr2b, fr2c, fr2d).resume(deps2)

    expect(fr2a.invocationCount).toBe(0)
    expect(fr2b.invocationCount).toBe(0)
    expect(fr2c.invocationCount).toBe(1)
    expect(fr2d.invocationCount).toBe(1)

    const raw2 = await fs.readFile(`${tmpDir}/${sharedRunId}/state.json`, 'utf-8')
    const finalState = JSON.parse(raw2)
    expect(finalState.status).toBe('completed')
    expect(Object.keys(finalState.steps)).toHaveLength(4)
    expect(finalState.steps['step-a'].value).toBe('a')
    expect(finalState.steps['step-c'].value).toBe('c-resumed')
  })

  it('resume resets status to running before re-executing', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-resume-test-')
    const sharedRunId = 'r-2026-04-13-res002' as RunId

    // First run: step A succeeds, step B crashes
    const fps1 = new FakeProcessService()
    const deps1 = makeDeps({ processService: fps1, runId: sharedRunId })

    const fr1a = new FakeRunner(fps1)
    fr1a.script({ structuredOutput: 'a' })
    const fr1b = new FakeRunner(fps1)
    fr1b.script({ failWith: { message: 'crash' } })

    const wf1 = workflow('status-check', async (run) => {
      await run(step.define('step-a', { agent: fr1a }))
      await run(step.define('step-b', { agent: fr1b }))
    })

    try {
      await wf1.execute(deps1)
    } catch {
      // expected
    }

    // Resume: capture status inside a step callback
    const fps2 = new FakeProcessService()
    const deps2 = makeDeps({ processService: fps2, runId: sharedRunId })

    let statusDuringResume: string | undefined

    const fr2a = new FakeRunner(fps2)
    fr2a.script({ structuredOutput: 'never' })
    const fr2b = new FakeRunner(fps2)
    fr2b.script({ structuredOutput: 'b-ok' })

    const wf2 = workflow('status-check', async (run) => {
      await run(step.define('step-a', { agent: fr2a }))

      // Read state during execution — status should be 'running'
      const state = await deps2.stateStore.loadRun(sharedRunId)
      statusDuringResume = state?.status

      await run(step.define('step-b', { agent: fr2b }))
    })
    await wf2.resume(deps2)

    expect(statusDuringResume).toBe('running')
  })

  it('double resume: crash at C, resume crashes at D, second resume completes', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-resume-test-')
    const sharedRunId = 'r-2026-04-13-res003' as RunId

    const buildWf = (frA: FakeRunner, frB: FakeRunner, frC: FakeRunner, frD: FakeRunner) =>
      workflow('double-resume', async (run) => {
        await run(step.define('step-a', { agent: frA }))
        await run(step.define('step-b', { agent: frB }))
        await run(step.define('step-c', { agent: frC }))
        await run(step.define('step-d', { agent: frD }))
      })

    // First run: A+B succeed, C crashes
    const fps1 = new FakeProcessService()
    const deps1 = makeDeps({ processService: fps1, runId: sharedRunId })
    const fr1a = new FakeRunner(fps1)
    fr1a.script({ structuredOutput: 'a' })
    const fr1b = new FakeRunner(fps1)
    fr1b.script({ structuredOutput: 'b' })
    const fr1c = new FakeRunner(fps1)
    fr1c.script({ failWith: { message: 'crash-c' } })
    const fr1d = new FakeRunner(fps1)
    fr1d.script({ structuredOutput: 'never' })

    try {
      await buildWf(fr1a, fr1b, fr1c, fr1d).execute(deps1)
    } catch {
      // expected
    }

    // First resume: C succeeds, D crashes
    const fps2 = new FakeProcessService()
    const deps2 = makeDeps({ processService: fps2, runId: sharedRunId })
    const fr2a = new FakeRunner(fps2)
    fr2a.script({ structuredOutput: 'never' })
    const fr2b = new FakeRunner(fps2)
    fr2b.script({ structuredOutput: 'never' })
    const fr2c = new FakeRunner(fps2)
    fr2c.script({ structuredOutput: 'c-ok' })
    const fr2d = new FakeRunner(fps2)
    fr2d.script({ failWith: { message: 'crash-d' } })

    try {
      await buildWf(fr2a, fr2b, fr2c, fr2d).resume(deps2)
    } catch {
      // expected
    }

    expect(fr2a.invocationCount).toBe(0)
    expect(fr2b.invocationCount).toBe(0)
    expect(fr2c.invocationCount).toBe(1)

    const afterFirstResume = await deps2.stateStore.loadRun(sharedRunId)
    expect(afterFirstResume?.status).toBe('crashed')
    expect(Object.keys(afterFirstResume?.steps ?? {})).toHaveLength(3)

    // Second resume: D succeeds
    const fps3 = new FakeProcessService()
    const deps3 = makeDeps({ processService: fps3, runId: sharedRunId })
    const fr3a = new FakeRunner(fps3)
    fr3a.script({ structuredOutput: 'never' })
    const fr3b = new FakeRunner(fps3)
    fr3b.script({ structuredOutput: 'never' })
    const fr3c = new FakeRunner(fps3)
    fr3c.script({ structuredOutput: 'never' })
    const fr3d = new FakeRunner(fps3)
    fr3d.script({ structuredOutput: 'd-ok' })

    await buildWf(fr3a, fr3b, fr3c, fr3d).resume(deps3)

    expect(fr3a.invocationCount).toBe(0)
    expect(fr3b.invocationCount).toBe(0)
    expect(fr3c.invocationCount).toBe(0)
    expect(fr3d.invocationCount).toBe(1)

    const finalState = await deps3.stateStore.loadRun(sharedRunId)
    expect(finalState?.status).toBe('completed')
    expect(Object.keys(finalState?.steps ?? {})).toHaveLength(4)
  })

  it('resume on run with zero completed steps re-executes all steps', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-resume-test-')
    const sharedRunId = 'r-2026-04-13-res004' as RunId

    // First run: workflow function throws before any step runs
    const fps1 = new FakeProcessService()
    const deps1 = makeDeps({ processService: fps1, runId: sharedRunId })

    const wf1 = workflow('pre-step-crash', async (_run) => {
      throw new Error('crash before any step')
    })

    try {
      await wf1.execute(deps1)
    } catch {
      // expected
    }

    const crashedState = await deps1.stateStore.loadRun(sharedRunId)
    expect(crashedState?.status).toBe('crashed')
    expect(Object.keys(crashedState?.steps ?? {})).toHaveLength(0)

    // Resume: all steps execute from scratch
    const fps2 = new FakeProcessService()
    const deps2 = makeDeps({ processService: fps2, runId: sharedRunId })

    const fr2a = new FakeRunner(fps2)
    fr2a.script({ structuredOutput: 'a' })
    const fr2b = new FakeRunner(fps2)
    fr2b.script({ structuredOutput: 'b' })

    const wf2 = workflow('pre-step-crash', async (run) => {
      await run(step.define('step-a', { agent: fr2a }))
      await run(step.define('step-b', { agent: fr2b }))
    })
    await wf2.resume(deps2)

    expect(fr2a.invocationCount).toBe(1)
    expect(fr2b.invocationCount).toBe(1)

    const finalState = await deps2.stateStore.loadRun(sharedRunId)
    expect(finalState?.status).toBe('completed')
    expect(Object.keys(finalState?.steps ?? {})).toHaveLength(2)
  })

  it('resume with parallel branches skips cached branch and re-runs failed one', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-resume-test-')
    const sharedRunId = 'r-2026-04-13-res005' as RunId

    // First run: branch-a succeeds, branch-b fails
    const fps1 = new FakeProcessService()
    const deps1 = makeDeps({ processService: fps1, runId: sharedRunId })

    const fr1a = new FakeRunner(fps1)
    fr1a.script({ structuredOutput: 'ok-a' })
    const fr1b = new FakeRunner(fps1)
    fr1b.script({ failWith: { message: 'boom-b' } })

    const buildWf = (frA: FakeRunner, frB: FakeRunner) =>
      workflow('parallel-resume', async (run) => {
        await parallel([
          run(step.define('branch-a', { agent: frA })),
          run(step.define('branch-b', { agent: frB })),
        ])
      })

    try {
      await buildWf(fr1a, fr1b).execute(deps1)
    } catch (err) {
      expect(err).toBeInstanceOf(ParallelError)
    }

    const crashed = await deps1.stateStore.loadRun(sharedRunId)
    expect(crashed?.steps['branch-a']?.value).toBe('ok-a')
    expect(crashed?.steps['branch-b']).toBeUndefined()

    // Resume: branch-a cached, branch-b succeeds
    const fps2 = new FakeProcessService()
    const deps2 = makeDeps({ processService: fps2, runId: sharedRunId })

    const fr2a = new FakeRunner(fps2)
    fr2a.script({ structuredOutput: 'should-not-run' })
    const fr2b = new FakeRunner(fps2)
    fr2b.script({ structuredOutput: 'ok-b' })

    await buildWf(fr2a, fr2b).resume(deps2)

    expect(fr2a.invocationCount).toBe(0)
    expect(fr2b.invocationCount).toBe(1)

    const finalState = await deps2.stateStore.loadRun(sharedRunId)
    expect(finalState?.status).toBe('completed')
    expect(finalState?.steps['branch-a']?.value).toBe('ok-a')
    expect(finalState?.steps['branch-b']?.value).toBe('ok-b')
  })

  it('resume with commit steps skips cached agent step and re-runs crashed commit', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-resume-test-')
    const sharedRunId = 'r-2026-04-13-res006' as RunId

    // First run: agent step succeeds, commit step crashes (via FakeGitService)
    const fps1 = new FakeProcessService()
    const git1 = new FakeGitService()
    git1.setIsClean(path('/workspace'), false)
    // No commitSha set — commit() will throw
    const deps1 = makeDeps({ processService: fps1, gitService: git1, runId: sharedRunId })

    const fr1 = new FakeRunner(fps1)
    fr1.script({ structuredOutput: 'research-done' })

    const RESEARCH = step.define('research', { agent: fr1 })
    const wf1 = workflow('commit-resume', async (run) => {
      await run(RESEARCH)
      await run(commit('after research'))
    })

    try {
      await wf1.execute(deps1)
    } catch {
      // expected — commit crashes because no sha configured
    }

    const crashed = await deps1.stateStore.loadRun(sharedRunId)
    expect(crashed?.status).toBe('crashed')
    expect(crashed?.steps.research?.value).toBe('research-done')
    expect(crashed?.steps['commit:after-research']).toBeUndefined()

    // Resume: agent cached, commit succeeds
    const fps2 = new FakeProcessService()
    const git2 = new FakeGitService()
    git2.setIsClean(path('/workspace'), false)
    git2.setCommitSha(path('/workspace'), 'abc1234')
    const deps2 = makeDeps({ processService: fps2, gitService: git2, runId: sharedRunId })

    const fr2 = new FakeRunner(fps2)
    fr2.script({ structuredOutput: 'never' })

    const wf2 = workflow('commit-resume', async (run) => {
      await run(step.define('research', { agent: fr2 }))
      await run(commit('after research'))
    })
    await wf2.resume(deps2)

    expect(fr2.invocationCount).toBe(0)

    const finalState = await deps2.stateStore.loadRun(sharedRunId)
    expect(finalState?.status).toBe('completed')
    expect(finalState?.steps['commit:after-research']?.value).toEqual({ sha: 'abc1234' })
  })

  describe('resume guards', () => {
    it('resume on completed run throws ResumeError with correct runId and status', async () => {
      tmpDir = await fs.mkdtemp('/tmp/orch-resume-test-')
      const sharedRunId = 'r-2026-04-13-res007' as RunId

      const fps = new FakeProcessService()
      const deps = makeDeps({ processService: fps, runId: sharedRunId })

      const fr = new FakeRunner(fps)
      fr.script({ structuredOutput: 'done' })

      const wf = workflow('completed-guard', async (run) => {
        await run(step.define('step-a', { agent: fr }))
      })
      await wf.execute(deps)

      const deps2 = makeDeps({ runId: sharedRunId })
      try {
        await wf.resume(deps2)
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(ResumeError)
        const re = err as ResumeError
        expect(re.runId).toBe(sharedRunId)
        expect(re.status).toBe('completed')
        expect(re.message).toContain('run already completed')
      }
    })

    it('resume on non-existent runId throws RunNotFoundError with correct runId', async () => {
      tmpDir = await fs.mkdtemp('/tmp/orch-resume-test-')
      const missingRunId = 'r-2026-04-13-res008' as RunId
      const deps = makeDeps({ runId: missingRunId })

      const wf = workflow('missing-guard', async (run) => {
        await run(step.define('step-a', { agent: new FakeRunner(deps.processService) }))
      })

      try {
        await wf.resume(deps)
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(RunNotFoundError)
        const rnf = err as RunNotFoundError
        expect(rnf.runId).toBe(missingRunId)
        expect(rnf.message).toContain('not found')
      }
    })

    it('resume on stuck running run succeeds', async () => {
      tmpDir = await fs.mkdtemp('/tmp/orch-resume-test-')
      const sharedRunId = 'r-2026-04-13-res009' as RunId

      // Create a run and manually set its status to 'running' (simulating SIGKILL)
      const deps1 = makeDeps({ runId: sharedRunId })

      // Manually init + set status to 'running' to simulate SIGKILL mid-execution
      await deps1.stateStore.initRun(sharedRunId)
      await deps1.stateStore.setStatus(sharedRunId, 'running')

      // Resume should accept 'running' status
      const fps2 = new FakeProcessService()
      const deps2 = makeDeps({ processService: fps2, runId: sharedRunId })

      const fr2 = new FakeRunner(fps2)
      fr2.script({ structuredOutput: 'resumed' })

      const wf2 = workflow('running-guard', async (run) => {
        await run(step.define('step-a', { agent: fr2 }))
      })
      await wf2.resume(deps2)

      expect(fr2.invocationCount).toBe(1)

      const finalState = await deps2.stateStore.loadRun(sharedRunId)
      expect(finalState?.status).toBe('completed')
    })
  })
})
