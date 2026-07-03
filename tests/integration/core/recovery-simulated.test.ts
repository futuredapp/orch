import { describe, expect, it } from 'bun:test'
import { createFakeHost } from '@orch/test/fake-host.ts'
import { backoffResume, noRetry } from '../../../src/core/index.ts'
import { step } from '../../../src/core/step.ts'
import type { WorkflowDeps } from '../../../src/core/workflow.ts'
import { workflow } from '../../../src/core/workflow.ts'
import type { FakeScript } from '../../../src/runners/index.ts'
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

// Behavior-first recovery tests: a SIMULATED agent (FakeRunner) emits some
// progress, then errors. With noRetry the workflow fails; with backoffResume the
// loop forks once, the simulated fork completes, and the run finishes. Unlike
// recovery-loop.test.ts (which scripts an immediate error), these simulate a
// realistic stream — progress BEFORE the error, and progress on the fork before
// it completes — in a Claude-shaped and a Codex-shaped flavor. Still a fake at
// the subprocess edge: no real CLI, no tmux (the user's "simulate, not real").

const rid = (s: string): RunId => s as RunId
const STATE_BASE = path('/runs')

/** One simulated assistant turn — the `InfoEvent` shape both runners emit. */
function assistant(text: string): InfoEvent {
  return { kind: 'info', type: 'assistant', payload: { text } }
}

/** A simulated agent's behavior across attempts, replayed through FakeRunner —
 *  a tiny in-file "cassette". `attempt1` works a bit then errors; `fork` resumes,
 *  makes progress, and completes. */
interface SimulatedBehavior {
  readonly attempt1: FakeScript
  readonly fork: FakeScript
}

// Claude-shaped: free-text assistant turns, a transient `overload` error, then a
// resumed turn that returns a structured `OK`.
const CLAUDE_BEHAVIOR: SimulatedBehavior = {
  attempt1: {
    events: [assistant('reading the failing test'), assistant('editing the source')],
    failWith: { message: 'overload' },
  },
  fork: {
    sessionId: 'claude-fork-1',
    events: [assistant('resuming from checkpoint'), assistant('done writing the fix')],
    structuredOutput: 'OK',
  },
}

// Codex-shaped: same behavior, codex-flavored narration. FakeRunner is
// runner-agnostic, so the only honest difference without the real adapter is the
// simulated content.
const CODEX_BEHAVIOR: SimulatedBehavior = {
  attempt1: {
    events: [assistant('exec: running the build'), assistant('exec: patching the module')],
    failWith: { message: 'overload' },
  },
  fork: {
    sessionId: 'codex-fork-1',
    events: [assistant('exec: resuming the thread'), assistant('exec: build passing')],
    structuredOutput: 'OK',
  },
}

interface Deps extends WorkflowDeps {
  fsService: FakeFsService
  processService: FakeProcessService
  clock: FakeClock
}

function makeDeps(runId: string): Deps {
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

// A fast recovery envelope so the test never waits real wall-clock.
const FAST = backoffResume({ waits: { overload: 1000 }, ceiling: 5, stallTimeoutMs: 1000 })

/** Build a simulated agent with recovery capabilities enabled and the given
 *  attempt scripts queued. The fork builder re-uses the spawn argv so each forked
 *  attempt drains the next queued script in order, and records its calls so a
 *  test can assert whether a fork happened. */
function simulate(deps: Deps, scripts: readonly FakeScript[], forkCalls: string[]): FakeRunner {
  const runner = new FakeRunner(deps.processService)
    .withClassifyError()
    .withProgressEvent()
    .withForkResumeCommand((_checkpoint, nudge) => {
      forkCalls.push(nudge)
      return runner.spawnArgv
    })
  for (const s of scripts) runner.script(s)
  return runner
}

for (const flavor of [
  { name: 'Claude', code: 'cl', behavior: CLAUDE_BEHAVIOR, forkId: 'claude-fork-1' },
  { name: 'Codex', code: 'cx', behavior: CODEX_BEHAVIOR, forkId: 'codex-fork-1' },
] as const) {
  describe(`a simulated ${flavor.name}-style agent that makes progress then errors`, () => {
    it('fails the workflow with no recovery when the step opts out via noRetry', async () => {
      const deps = makeDeps(`r-2026-06-08-200001-${flavor.code}`)
      const forkCalls: string[] = []
      const runner = simulate(deps, [flavor.behavior.attempt1], forkCalls)

      const STEP = step.define('analyze', { agent: runner, recovery: noRetry() })
      const wf = workflow('no-recovery', async (run) => {
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

    it('forks once and completes when the step enables backoffResume recovery', async () => {
      const deps = makeDeps(`r-2026-06-08-200002-${flavor.code}`)
      const forkCalls: string[] = []
      const runner = simulate(deps, [flavor.behavior.attempt1, flavor.behavior.fork], forkCalls)

      const STEP = step.define('analyze', { agent: runner, recovery: FAST })
      const wf = workflow('with-recovery', async (run) => {
        await run(STEP)
      })

      await driveClock(wf.execute(deps), deps.clock, 1000)

      expect(forkCalls).toEqual(['continue'])
      const state = await deps.stateStore.loadRun(deps.runId)
      expect(state?.status).toBe('completed')
      expect(state?.steps.analyze?.value).toBe('OK')
      expect(state?.steps.analyze?.sessionId).toBe(flavor.forkId)
      expect(state?.steps.analyze?.recoveryLog).toEqual([
        {
          attemptIndex: 1,
          errorClass: 'overload',
          waitMs: 1000,
          parentSessionId: 'checkpoint-uuid',
          forkSessionId: flavor.forkId,
          outcome: 'completed',
        },
      ])
    })
  })
}

// The recovery-declined path (R15): a fail-fast category stops recovery without a
// fork, and the thrown StepError must carry BOTH the declined summary AND the
// runner's real terminal message - so a human can still see WHY it died, not just
// that it was "not retryable".
describe('a simulated agent that dies with a non-retryable launch reason', () => {
  it('includes the runner error message when recovery declines a fail-fast category', async () => {
    const deps = makeDeps('r-2026-06-08-200003-ff')
    const forkCalls: string[] = []
    const runner = simulate(
      deps,
      [
        {
          events: [assistant('launching the agent')],
          failWith: { message: 'auth failed: Error loading rules: invalid decision: deny' },
        },
      ],
      forkCalls,
    )

    const STEP = step.define('analyze', { agent: runner, recovery: FAST })
    const wf = workflow('recovery-declined', async (run) => {
      await run(STEP)
    })

    let caught: unknown
    await wf.execute(deps).catch((e) => {
      caught = e
    })

    expect(forkCalls).toHaveLength(0)
    expect(caught).toBeInstanceOf(Error)
    const message = (caught as Error).message
    expect(message).toContain('recovery declined — auth is not retryable')
    expect(message).toContain('Error loading rules: invalid decision: deny')

    // The fast-fail now persists a StepEntry whose recoveryLog names the class,
    // so a field diagnosis reads the errorClass straight from state.json.
    const state = await deps.stateStore.loadRun(deps.runId)
    expect(state?.status).toBe('failed')
    expect(state?.steps.analyze?.recoveryLog).toHaveLength(1)
    expect(state?.steps.analyze?.recoveryLog?.[0]).toMatchObject({
      errorClass: 'auth',
      outcome: 'failed-fast',
    })
  })
})
