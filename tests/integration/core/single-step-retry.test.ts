import { describe, expect, it } from 'bun:test'
import { createFakeHost } from '@orch/test/fake-host.ts'
import { noRetry } from '../../../src/core/index.ts'
import { step } from '../../../src/core/step.ts'
import type { WorkflowDeps } from '../../../src/core/workflow.ts'
import { workflow } from '../../../src/core/workflow.ts'
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

// U5/KTD-8: the single-step retry primitive (`executor.retryStep`). These drive
// the public executor with a FakeRunner over a real FileStateStore, proving that
// `[r]` re-runs exactly the failed step then re-parks — the run status stays
// `failed`, the step's attempt-state flips to success, and no later step runs.

const rid = (s: string): RunId => s as RunId
const STATE_BASE = path('/runs')

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

// A three-step workflow whose middle step is the one that fails. step1 succeeds
// (and is cache-replayed on retry), step2 is the failure under test, and step3
// must NOT run when `[r]` retries step2 (single-step park).
function buildThreeStepWorkflow(deps: Deps): {
  readonly wf: ReturnType<typeof workflow>
  readonly step2: FakeRunner
} {
  const r1 = new FakeRunner(deps.processService)
  r1.script({ structuredOutput: 'one-ok' })

  const step2 = new FakeRunner(deps.processService)

  const r3 = new FakeRunner(deps.processService)
  r3.script({ structuredOutput: 'three-ok' })

  const S1 = step.define('step1', { agent: r1 })
  const S2 = step.define('step2', { agent: step2, recovery: noRetry() })
  const S3 = step.define('step3', { agent: r3 })

  const wf = workflow('three-step', async (run) => {
    await run(S1)
    await run(S2)
    await run(S3)
  })
  return { wf, step2 }
}

describe('executor.retryStep — single-step retry park (KTD-8)', () => {
  it('re-runs only the failed step, marks it ok, keeps the run failed, and runs no later step (AT-R1)', async () => {
    const deps = makeDeps('r-2026-06-09-100001-aa')
    const { wf, step2 } = buildThreeStepWorkflow(deps)
    step2.script({ failWith: { message: 'boom', exitCode: 7 } }) // initial failure
    step2.script({ structuredOutput: 'two-ok' }) // the retry now passes

    await wf.execute(deps).catch(() => {})
    const failed = await deps.stateStore.loadRun(deps.runId)
    expect(failed?.status).toBe('failed')
    expect(failed?.steps.step1?.value).toBe('one-ok')
    expect(failed?.steps.step2).toBeUndefined() // never persisted a success
    expect(failed?.steps.step3).toBeUndefined()

    const result = await wf.retryStep(deps)

    expect(result.outcome).toBe('retried-ok')
    const parked = await deps.stateStore.loadRun(deps.runId)
    expect(parked?.status).toBe('failed') // KTD-8: status stays failed
    expect(parked?.steps.step2?.value).toBe('two-ok') // step flipped to success
    expect(parked?.steps.step3).toBeUndefined() // no later step ran (parked)
  })

  it('returns failed-again and leaves the run failed when the retried step fails again (AT-R2)', async () => {
    const deps = makeDeps('r-2026-06-09-100002-bb')
    const { wf, step2 } = buildThreeStepWorkflow(deps)
    step2.script({ failWith: { message: 'boom', exitCode: 7 } }) // initial failure
    step2.script({ failWith: { message: 'boom-again', exitCode: 7 } }) // retry fails again

    await wf.execute(deps).catch(() => {})

    const result = await wf.retryStep(deps)

    expect(result.outcome).toBe('failed-again')
    const parked = await deps.stateStore.loadRun(deps.runId)
    expect(parked?.status).toBe('failed')
    expect(parked?.steps.step3).toBeUndefined()
  })

  it('refuses to retry a non-failed run', async () => {
    const deps = makeDeps('r-2026-06-09-100003-cc')
    const r1 = new FakeRunner(deps.processService)
    r1.script({ structuredOutput: 'one-ok' })
    const S1 = step.define('step1', { agent: r1 })
    const wf = workflow('one-step', async (run) => {
      await run(S1)
    })

    await wf.execute(deps)
    const completed = await deps.stateStore.loadRun(deps.runId)
    expect(completed?.status).toBe('completed')

    await expect(wf.retryStep(deps)).rejects.toThrow()
  })
})
