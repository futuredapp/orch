import { describe, expect, it } from 'bun:test'
import { z } from 'zod'
import { ParallelError, parallel } from '../../../src/core/parallel.ts'
import { schema } from '../../../src/core/schema.ts'
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
import { createFakeHost } from '../../helpers/fake-host.ts'

const rid = (s: string): RunId => s as RunId
const BASE = path('/runs')

function makeDeps(overrides?: {
  fs?: FakeFsService
  processService?: FakeProcessService
  runId?: RunId
}): WorkflowDeps & {
  fs: FakeFsService
  processService: FakeProcessService
  clock: FakeClock
} {
  const fs = overrides?.fs ?? new FakeFsService()
  const processService = overrides?.processService ?? new FakeProcessService()
  const clock = new FakeClock(1000)
  return {
    fs,
    fsService: fs,
    gitService: new FakeGitService(),
    processService,
    clock,
    stateStore: new FileStateStore({ fs, basePath: BASE }),
    runId: overrides?.runId ?? rid('r-2026-04-12-423020-l8'),
    cwd: path('/workspace'),
    host: createFakeHost(),
    promptService: new FakePromptService(),
    interactivity: 'interactive' as const,
  }
}

describe('parallel — mocked integration', () => {
  it('heterogeneous parallel persists both step entries', async () => {
    const deps = makeDeps()

    const frPlan = new FakeRunner(deps.processService)
    frPlan.script({ structuredOutput: 'plan-result' })
    const frCode = new FakeRunner(deps.processService)
    frCode.script({ structuredOutput: 'code-result' })

    const PLAN = step.define('plan', { agent: frPlan })
    const CODE = step.define('code', { agent: frCode })

    let planVal: unknown
    let codeVal: unknown
    const wf = workflow('test-hetero', async (run) => {
      ;[planVal, codeVal] = await parallel([run(PLAN), run(CODE)])
    })
    await wf.execute(deps)

    expect(planVal).toBe('plan-result')
    expect(codeVal).toBe('code-result')

    const state = await deps.stateStore.loadRun(deps.runId)
    expect(state?.status).toBe('completed')
    expect(Object.keys(state?.steps ?? {})).toHaveLength(2)
    expect(state?.steps.plan?.value).toBe('plan-result')
    expect(state?.steps.code?.value).toBe('code-result')
  })

  it('homogeneous parallel creates entries with as-override names', async () => {
    const deps = makeDeps({ runId: rid('r-2026-04-12-200640-3c') })
    const files = ['file-a', 'file-b', 'file-c']

    const wf = workflow('test-homo', async (run) => {
      const results = await parallel(files, (f) => {
        const fr = new FakeRunner(deps.processService)
        fr.script({ structuredOutput: `reviewed-${f}` })
        const REVIEW = step.define('review', { agent: fr })
        return run(REVIEW, { as: `review-${f}` })
      })

      expect(results).toEqual(['reviewed-file-a', 'reviewed-file-b', 'reviewed-file-c'])
    })
    await wf.execute(deps)

    const state = await deps.stateStore.loadRun(rid('r-2026-04-12-200640-3c'))
    expect(state?.status).toBe('completed')
    expect(Object.keys(state?.steps ?? {})).toHaveLength(3)
    expect(state?.steps['review-file-a']?.value).toBe('reviewed-file-a')
    expect(state?.steps['review-file-b']?.value).toBe('reviewed-file-b')
    expect(state?.steps['review-file-c']?.value).toBe('reviewed-file-c')
  })

  it('resume skips completed branches and re-runs failed ones', async () => {
    const sharedFs = new FakeFsService()
    const sharedRunId = rid('r-2026-04-12-978256-kg')

    // First run: branch-a succeeds, branch-b fails
    const fps1 = new FakeProcessService()
    const deps1 = makeDeps({ fs: sharedFs, processService: fps1, runId: sharedRunId })

    const fr1a = new FakeRunner(fps1)
    fr1a.script({ structuredOutput: 'ok-a' })
    const fr1b = new FakeRunner(fps1)
    fr1b.script({ failWith: { message: 'boom-b' } })

    const STEP_A = step.define('branch-a', { agent: fr1a })
    const STEP_B = step.define('branch-b', { agent: fr1b })

    const wf1 = workflow('test-resume', async (run) => {
      await parallel([run(STEP_A), run(STEP_B)])
    })

    let caught: unknown
    try {
      await wf1.execute(deps1)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ParallelError)

    // branch-a persisted, branch-b did not
    const crashed = await deps1.stateStore.loadRun(sharedRunId)
    expect(crashed?.steps['branch-a']?.value).toBe('ok-a')
    expect(crashed?.steps['branch-b']).toBeUndefined()

    // Second run: same runId — branch-a cached, branch-b succeeds
    const fps2 = new FakeProcessService()
    const deps2 = makeDeps({ fs: sharedFs, processService: fps2, runId: sharedRunId })

    const fr2a = new FakeRunner(fps2)
    fr2a.script({ structuredOutput: 'should-not-run' })
    const fr2b = new FakeRunner(fps2)
    fr2b.script({ structuredOutput: 'ok-b' })

    const wf2 = workflow('test-resume', async (run) => {
      await parallel([
        run(step.define('branch-a', { agent: fr2a })),
        run(step.define('branch-b', { agent: fr2b })),
      ])
    })
    await wf2.execute(deps2)

    expect(fr2a.invocationCount).toBe(0)
    expect(fr2b.invocationCount).toBe(1)

    const final = await deps2.stateStore.loadRun(sharedRunId)
    expect(final?.status).toBe('completed')
    expect(final?.steps['branch-a']?.value).toBe('ok-a')
    expect(final?.steps['branch-b']?.value).toBe('ok-b')
  })

  it('concurrency cap 2 over 5 items limits active runners', async () => {
    const deps = makeDeps({ runId: rid('r-2026-04-12-755876-2k') })
    let active = 0
    let maxActive = 0

    const wf = workflow('test-concurrency', async (run) => {
      await parallel(
        [1, 2, 3, 4, 5],
        (n) => {
          active++
          maxActive = Math.max(maxActive, active)
          const fr = new FakeRunner(deps.processService)
          fr.script({ structuredOutput: `result-${n}` })
          const s = step.define('item', { agent: fr })
          // The run() call is async — decrement active after it settles
          return run(s, { as: `item-${n}` }).then((v) => {
            active--
            return v
          })
        },
        { concurrency: 2 },
      )
    })
    await wf.execute(deps)

    expect(maxActive).toBeLessThanOrEqual(2)

    const state = await deps.stateStore.loadRun(rid('r-2026-04-12-755876-2k'))
    expect(Object.keys(state?.steps ?? {})).toHaveLength(5)
  })

  it('schema steps return Zod-parsed values through parallel', async () => {
    const deps = makeDeps({ runId: rid('r-2026-04-12-533496-jo') })

    const resultSchema = z.object({ score: z.number(), label: z.string() })

    const frA = new FakeRunner(deps.processService)
    frA.script({ structuredOutput: { score: 95, label: 'excellent' } })
    const frB = new FakeRunner(deps.processService)
    frB.script({ structuredOutput: { score: 72, label: 'good' } })

    const EVAL_A = step.define('eval-a', {
      agent: frA,
      returns: schema(resultSchema),
    })
    const EVAL_B = step.define('eval-b', {
      agent: frB,
      returns: schema(resultSchema),
    })

    let results: unknown[] = []
    const wf = workflow('test-schema-parallel', async (run) => {
      results = await parallel([run(EVAL_A), run(EVAL_B)])
    })
    await wf.execute(deps)

    expect(results).toEqual([
      { score: 95, label: 'excellent' },
      { score: 72, label: 'good' },
    ])

    const state = await deps.stateStore.loadRun(rid('r-2026-04-12-533496-jo'))
    expect(state?.steps['eval-a']?.value).toEqual({ score: 95, label: 'excellent' })
    expect(state?.steps['eval-b']?.value).toEqual({ score: 72, label: 'good' })
  })
})
