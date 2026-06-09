import { describe, expect, it } from 'bun:test'
import { createFakeHost } from '@orch/test/fake-host.ts'
import { parallel } from '../../../src/core/parallel.ts'
import { step } from '../../../src/core/step.ts'
import type { WorkflowDeps } from '../../../src/core/workflow.ts'
import { workflow } from '../../../src/core/workflow.ts'
import { FakeRunner } from '../../../src/runners/index.ts'
import type { CaptureResult } from '../../../src/runners/types.ts'
import {
  FakeClock,
  FakeFsService,
  FakeGitService,
  FakeProcessService,
  path,
} from '../../../src/services/index.ts'
import { FakePromptService } from '../../../src/services/prompt/index.ts'
import { FileStateStore, type RunId } from '../../../src/state/index.ts'

// U4/U6: produceAgentStep now runs the post-spawn session-id capture on the
// AUTONOMOUS path (it previously lived only on the interactive path). These
// tests drive that wiring through the public executor with a FakeRunner whose
// capture behavior is scripted — proving the captured id (not the orch UUID)
// becomes the persisted resumable checkpoint, that a capture error is recorded
// instead, and that the per-workflow CaptureLock is threaded so concurrent
// autonomous steps persist their OWN id without cross-attribution.

const rid = (s: string): RunId => s as RunId
const BASE = path('/runs')

function makeDeps(runId: string): WorkflowDeps & {
  fsService: FakeFsService
  processService: FakeProcessService
} {
  const fs = new FakeFsService()
  return {
    fsService: fs,
    gitService: new FakeGitService(),
    processService: new FakeProcessService(),
    clock: new FakeClock(1000),
    stateStore: new FileStateStore({ fs, basePath: BASE }),
    runId: rid(runId),
    cwd: path('/workspace'),
    host: createFakeHost(),
    promptService: new FakePromptService(),
    interactivity: 'interactive' as const,
    // Fixed so the no-capture (Claude-like) case can assert the persisted id.
    generateSessionId: () => 'orch-fixed-uuid',
  }
}

function captureResolving(result: CaptureResult): {
  snapshotReady: Promise<void>
  result: Promise<CaptureResult>
} {
  return { snapshotReady: Promise.resolve(), result: Promise.resolve(result) }
}

describe('autonomous session-id capture wiring', () => {
  it('persists the captured thread id (not the orch UUID) as the autonomous step sessionId', async () => {
    const deps = makeDeps('r-2026-06-02-000001-aa')
    const runner = new FakeRunner(deps.processService)
      .withResumeCommand()
      .withCaptureSessionId(() => captureResolving({ sessionId: 'captured-thread-123' }))
    runner.script({ structuredOutput: 'ok' })

    const STEP = step.define('analyze', { agent: runner })
    const wf = workflow('cap', async (run) => {
      await run(STEP)
    })
    await wf.execute(deps)

    const state = await deps.stateStore.loadRun(deps.runId)
    expect(state?.steps.analyze?.sessionId).toBe('captured-thread-123')
    expect(state?.steps.analyze?.sessionIdCaptureError).toBeUndefined()
  })

  it('records the capture error and omits sessionId when capture is ambiguous', async () => {
    const deps = makeDeps('r-2026-06-02-000002-bb')
    const runner = new FakeRunner(deps.processService)
      .withResumeCommand()
      .withCaptureSessionId(() => captureResolving({ error: 'ambiguous' }))
    runner.script({ structuredOutput: 'ok' })

    const STEP = step.define('analyze', { agent: runner })
    const wf = workflow('cap-err', async (run) => {
      await run(STEP)
    })
    await wf.execute(deps)

    const state = await deps.stateStore.loadRun(deps.runId)
    expect(state?.steps.analyze?.sessionId).toBeUndefined()
    expect(state?.steps.analyze?.sessionIdCaptureError).toBe('ambiguous')
  })

  it('persists the orch UUID for a resume-capable runner that pre-sets its id (no captureSessionId)', async () => {
    const deps = makeDeps('r-2026-06-02-000003-cc')
    const runner = new FakeRunner(deps.processService).withResumeCommand()
    runner.script({ structuredOutput: 'ok' })

    const STEP = step.define('analyze', { agent: runner })
    const wf = workflow('cap-claude', async (run) => {
      await run(STEP)
    })
    await wf.execute(deps)

    const state = await deps.stateStore.loadRun(deps.runId)
    expect(state?.steps.analyze?.sessionId).toBe('orch-fixed-uuid')
  })

  it('does not persist a sessionId for a runner with no resume/fork capability', async () => {
    const deps = makeDeps('r-2026-06-02-000004-dd')
    const runner = new FakeRunner(deps.processService)
    runner.script({ structuredOutput: 'ok' })

    const STEP = step.define('analyze', { agent: runner })
    const wf = workflow('cap-none', async (run) => {
      await run(STEP)
    })
    await wf.execute(deps)

    const state = await deps.stateStore.loadRun(deps.runId)
    expect(state?.steps.analyze?.sessionId).toBeUndefined()
  })

  it('persists each concurrent autonomous step its own captured id without cross-attribution', async () => {
    const deps = makeDeps('r-2026-06-02-000005-ee')

    const wf = workflow('cap-parallel', async (run) => {
      await parallel(
        ['a', 'b'].map((tag) => {
          const runner = new FakeRunner(deps.processService)
            .withResumeCommand()
            .withCaptureSessionId(() => captureResolving({ sessionId: `thread-${tag}` }))
          runner.script({ structuredOutput: `done-${tag}` })
          const STEP = step.define('work', { agent: runner })
          return run(STEP, { as: `work-${tag}` })
        }),
      )
    })
    await wf.execute(deps)

    const state = await deps.stateStore.loadRun(deps.runId)
    expect(state?.steps['work-a']?.sessionId).toBe('thread-a')
    expect(state?.steps['work-b']?.sessionId).toBe('thread-b')
  })
})
