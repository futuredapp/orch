import { describe, expect, it } from 'bun:test'
import { createFakeHost } from '@orch/test/fake-host.ts'
import { backoffResume, noRetry } from '../../../src/core/index.ts'
import { step } from '../../../src/core/step.ts'
import type { WorkflowDeps } from '../../../src/core/workflow.ts'
import { workflow } from '../../../src/core/workflow.ts'
import { createFileSessionLogger } from '../../../src/observability/index.ts'
import { FakeRunner } from '../../../src/runners/index.ts'
import type { InfoEvent } from '../../../src/runners/types.ts'
import {
  FakeClock,
  FakeFsService,
  FakeGitService,
  FakeProcessService,
  path,
} from '../../../src/services/index.ts'
import { FakePromptService } from '../../../src/services/prompt/index.ts'
import { FileStateStore, type RunId } from '../../../src/state/index.ts'

// U7: the recovery loop wired at the autonomous executor seam. These drive the
// public executor with a FakeRunner whose recovery capabilities are scripted,
// proving fork-from-checkpoint (R8), exactly-one-nudge-per-attempt (R7), the
// give-up envelope (R10), failure-path recovery-log persistence (R16), the
// resume-in-place degrade (R4), and noRetry parity (R2/AE7).

const rid = (s: string): RunId => s as RunId
const STATE_BASE = path('/runs')
const ASSISTANT: InfoEvent = { kind: 'info', type: 'assistant', payload: { text: 'working' } }

interface Deps extends WorkflowDeps {
  fsService: FakeFsService
  processService: FakeProcessService
  clock: FakeClock
}

function makeDeps(runId: string, logsBase?: string): Deps {
  const fs = new FakeFsService()
  const clock = new FakeClock(1000)
  return {
    fsService: fs,
    gitService: new FakeGitService(),
    processService: new FakeProcessService(),
    clock,
    stateStore: new FileStateStore({ fs, basePath: STATE_BASE }),
    runId: rid(runId),
    cwd: path('/workspace'),
    host: createFakeHost(),
    promptService: new FakePromptService(),
    interactivity: 'interactive' as const,
    generateSessionId: () => 'checkpoint-uuid',
    ...(logsBase !== undefined
      ? {
          logger: createFileSessionLogger({
            fs,
            clock,
            runId: rid(runId),
            basePath: path(logsBase),
            debug: false,
          }),
        }
      : {}),
  }
}

/** Advance the FakeClock in fixed steps until the workflow promise settles, so
 *  the loop's `clock.sleep(delay)` between attempts resolves. */
async function driveClock<T>(promise: Promise<T>, clock: FakeClock, stepMs: number): Promise<T> {
  let done = false
  promise.then(
    () => {
      done = true
    },
    () => {
      done = true
    },
  )
  for (let i = 0; i < 500 && !done; i++) {
    await new Promise((r) => setImmediate(r))
    if (done) break
    clock.advance(stepMs)
  }
  return promise
}

const FAST = backoffResume({ waits: { overload: 1000 }, ceiling: 5, stallTimeoutMs: 1000 })

// ---------------------------------------------------------------------------
// Recover then complete (AE1 — R5, R7, R8, R9)
// ---------------------------------------------------------------------------

describe('recovery loop at the executor seam', () => {
  it('forks once from the checkpoint, sends a single nudge, recovers, and persists the fork id', async () => {
    const deps = makeDeps('r-2026-06-02-100001-aa')
    const forkCalls: Array<{ checkpoint: string; nudge: string }> = []
    const runner = new FakeRunner(deps.processService)
      .withClassifyError()
      .withProgressEvent()
      .withForkResumeCommand((checkpoint, nudge) => {
        forkCalls.push({ checkpoint, nudge })
        return runner.spawnArgv
      })
    runner.script({ failWith: { message: 'overload' } })
    runner.script({ sessionId: 'fork-1', events: [ASSISTANT], structuredOutput: 'done' })

    const STEP = step.define('analyze', { agent: runner, recovery: FAST })
    const wf = workflow('recover', async (run) => {
      await run(STEP)
    })
    await driveClock(wf.execute(deps), deps.clock, 1000)

    expect(forkCalls).toHaveLength(1)
    expect(forkCalls[0]).toEqual({ checkpoint: 'checkpoint-uuid', nudge: 'continue' })

    const state = await deps.stateStore.loadRun(deps.runId)
    expect(state?.status).toBe('completed')
    expect(state?.steps.analyze?.value).toBe('done')
    expect(state?.steps.analyze?.sessionId).toBe('fork-1')
    expect(state?.steps.analyze?.recoveryLog).toEqual([
      {
        attemptIndex: 1,
        errorClass: 'overload',
        waitMs: 1000,
        parentSessionId: 'checkpoint-uuid',
        forkSessionId: 'fork-1',
        outcome: 'completed',
      },
    ])
  })

  it('gives up after the ceiling and persists the recovery log on the failed run (R10/R16)', async () => {
    const deps = makeDeps('r-2026-06-02-100002-bb')
    const forkCalls: string[] = []
    const runner = new FakeRunner(deps.processService)
      .withClassifyError()
      .withProgressEvent()
      .withForkResumeCommand((_checkpoint, nudge) => {
        forkCalls.push(nudge)
        return runner.spawnArgv
      })
    // Initial error + 5 forked errors → ceiling (5) trips, no 6th fork.
    for (let i = 0; i < 6; i++) runner.script({ failWith: { message: 'overload' } })

    const STEP = step.define('analyze', { agent: runner, recovery: FAST })
    const wf = workflow('giveup', async (run) => {
      await run(STEP)
    })

    let caught: unknown
    await driveClock(
      wf.execute(deps).catch((e) => {
        caught = e
      }),
      deps.clock,
      1000,
    )

    expect(forkCalls).toHaveLength(5)
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain('gave up')
    expect((caught as Error).message).toContain('overload')

    const state = await deps.stateStore.loadRun(deps.runId)
    expect(state?.status).toBe('failed')
    const log = state?.steps.analyze?.recoveryLog ?? []
    expect(log.map((e) => e.outcome)).toEqual([
      'errored-again',
      'errored-again',
      'errored-again',
      'errored-again',
      'errored-again',
      'gave-up',
    ])
  })

  it('keeps noRetry identical to today — one StepError, no fork, no recovery log (AE7/R2)', async () => {
    const deps = makeDeps('r-2026-06-02-100003-cc')
    const forkCalls: string[] = []
    const runner = new FakeRunner(deps.processService)
      .withClassifyError()
      .withForkResumeCommand((_c, nudge) => {
        forkCalls.push(nudge)
        return runner.spawnArgv
      })
    runner.script({ failWith: { message: 'overload', exitCode: 7 } })

    const STEP = step.define('analyze', { agent: runner, recovery: noRetry() })
    const wf = workflow('noretry', async (run) => {
      await run(STEP)
    })

    let caught: unknown
    await wf.execute(deps).catch((e) => {
      caught = e
    })

    expect(forkCalls).toHaveLength(0)
    expect((caught as Error).message).toContain('overload')
    const state = await deps.stateStore.loadRun(deps.runId)
    expect(state?.status).toBe('failed')
    expect(state?.steps.analyze?.recoveryLog).toBeUndefined()
  })

  it('fails fast within the loop on an auth class — no fork, no wait (R12)', async () => {
    const deps = makeDeps('r-2026-06-02-100004-dd')
    const forkCalls: string[] = []
    const runner = new FakeRunner(deps.processService)
      .withClassifyError()
      .withForkResumeCommand((_c, nudge) => {
        forkCalls.push(nudge)
        return runner.spawnArgv
      })
    runner.script({ failWith: { message: 'auth' } })

    const STEP = step.define('analyze', { agent: runner, recovery: FAST })
    const wf = workflow('failfast', async (run) => {
      await run(STEP)
    })

    let caught: unknown
    await wf.execute(deps).catch((e) => {
      caught = e
    })

    expect(forkCalls).toHaveLength(0)
    expect((caught as Error).message).toContain('not retryable')
  })

  it('degrades to resume-in-place when the runner has no fork primitive (R4/R7)', async () => {
    const deps = makeDeps('r-2026-06-02-100005-ee')
    const resumeCalls: string[] = []
    const runner = new FakeRunner(deps.processService).withClassifyError().withProgressEvent()
    // No forkResumeCommand; resume-in-place points at the spawn argv so the
    // scripted queue drains across attempts.
    runner.withResumeCommand((sessionId) => {
      resumeCalls.push(sessionId)
      return runner.spawnArgv
    })
    runner.script({ failWith: { message: 'overload' } })
    runner.script({ sessionId: 'resumed-1', events: [ASSISTANT], structuredOutput: 'done' })

    const STEP = step.define('analyze', { agent: runner, recovery: FAST })
    const wf = workflow('resume-in-place', async (run) => {
      await run(STEP)
    })
    await driveClock(wf.execute(deps), deps.clock, 1000)

    expect(resumeCalls).toEqual(['checkpoint-uuid'])
    const state = await deps.stateStore.loadRun(deps.runId)
    expect(state?.status).toBe('completed')
    expect(state?.steps.analyze?.recoveryLog?.[0]?.outcome).toBe('completed')
  })

  it('emits one spawn span entry per attempt — no forked attempt is lost', async () => {
    const deps = makeDeps('r-2026-06-02-100006-ff', '/logs')
    const runner = new FakeRunner(deps.processService)
      .withClassifyError()
      .withProgressEvent()
      .withForkResumeCommand(() => runner.spawnArgv)
    runner.script({ failWith: { message: 'overload' } })
    runner.script({ sessionId: 'fork-1', events: [ASSISTANT], structuredOutput: 'done' })

    const STEP = step.define('analyze', { agent: runner, recovery: FAST })
    const wf = workflow('spawns', async (run) => {
      await run(STEP)
    })
    await driveClock(wf.execute(deps), deps.clock, 1000)

    const raw = await deps.fsService.readFile(
      path('/logs/r-2026-06-02-100006-ff/logs/spawns.ndjson'),
    )
    const spawnRecords = raw
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { stepName?: string })
      .filter((r) => r.stepName === 'analyze')
    // One for the initial attempt, one for the fork.
    expect(spawnRecords).toHaveLength(2)
  })
})
