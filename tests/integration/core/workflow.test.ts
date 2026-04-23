import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import { z } from 'zod'
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
import { createFakeHost } from '../../helpers/fake-host.ts'

let tmpDir: string

afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

function makeIntegrationDeps(overrides?: {
  processService?: FakeProcessService
  runId?: RunId
}): WorkflowDeps & {
  processService: FakeProcessService
  clock: FakeClock
  basePath: string
} {
  const processService = overrides?.processService ?? new FakeProcessService()
  const clock = new FakeClock(1000)
  const bunFs = new BunFsService()
  return {
    processService,
    clock,
    fsService: bunFs,
    gitService: new FakeGitService(),
    stateStore: new FileStateStore({ fs: bunFs, basePath: path(tmpDir) }),
    runId: overrides?.runId ?? ('r-2026-04-10-000001' as RunId),
    cwd: path('/workspace'),
    host: createFakeHost(),
    basePath: tmpDir,
  }
}

describe('workflow (integration)', () => {
  it('four-step fake workflow runs end-to-end and persists all steps in state.json', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-wf-test-')
    const fps = new FakeProcessService()
    const deps = makeIntegrationDeps({ processService: fps })

    const frA = new FakeRunner(fps)
    frA.script({ structuredOutput: 'result-a' })
    const frB = new FakeRunner(fps)
    frB.script({ structuredOutput: 'result-b' })
    const frC = new FakeRunner(fps)
    frC.script({ structuredOutput: 'result-c' })
    const frD = new FakeRunner(fps)
    frD.script({ structuredOutput: 'result-d' })

    const STEP_A = step.define('step-a', { agent: frA })
    const STEP_B = step.define('step-b', { agent: frB })
    const STEP_C = step.define('step-c', { agent: frC })
    const STEP_D = step.define('step-d', { agent: frD })

    const wf = workflow('four-step', async (run) => {
      await run(STEP_A)
      await run(STEP_B)
      await run(STEP_C)
      await run(STEP_D)
    })
    await wf.execute(deps)

    const raw = await fs.readFile(`${tmpDir}/${deps.runId}/state.json`, 'utf-8')
    const state = JSON.parse(raw)
    expect(state.status).toBe('completed')
    expect(Object.keys(state.steps)).toHaveLength(4)
    expect(state.steps['step-a'].value).toBe('result-a')
    expect(state.steps['step-b'].value).toBe('result-b')
    expect(state.steps['step-c'].value).toBe('result-c')
    expect(state.steps['step-d'].value).toBe('result-d')
  })

  it('four-step workflow with crash at step 3, then resume completes all steps', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-wf-test-')
    const sharedRunId = 'r-2026-04-10-000001' as RunId

    // First run: steps 1-2 succeed, step 3 crashes
    const fps1 = new FakeProcessService()
    const deps1 = makeIntegrationDeps({ processService: fps1, runId: sharedRunId })

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

    // Verify state after crash
    const crashedRaw = await fs.readFile(`${tmpDir}/${sharedRunId}/state.json`, 'utf-8')
    const crashedState = JSON.parse(crashedRaw)
    expect(crashedState.status).toBe('crashed')
    expect(Object.keys(crashedState.steps)).toHaveLength(2)

    // Second run: resume with same runId — steps a,b cached; c,d run fresh
    const fps2 = new FakeProcessService()
    const deps2 = makeIntegrationDeps({ processService: fps2, runId: sharedRunId })

    const fr2a = new FakeRunner(fps2)
    fr2a.script({ structuredOutput: 'never' })
    const fr2b = new FakeRunner(fps2)
    fr2b.script({ structuredOutput: 'never' })
    const fr2c = new FakeRunner(fps2)
    fr2c.script({ structuredOutput: 'c-resumed' })
    const fr2d = new FakeRunner(fps2)
    fr2d.script({ structuredOutput: 'd-resumed' })

    await buildWf(fr2a, fr2b, fr2c, fr2d).execute(deps2)

    expect(fr2a.invocationCount).toBe(0)
    expect(fr2b.invocationCount).toBe(0)
    expect(fr2c.invocationCount).toBe(1)
    expect(fr2d.invocationCount).toBe(1)

    const finalRaw = await fs.readFile(`${tmpDir}/${sharedRunId}/state.json`, 'utf-8')
    const finalState = JSON.parse(finalRaw)
    expect(finalState.status).toBe('completed')
    expect(Object.keys(finalState.steps)).toHaveLength(4)
  })

  it('state.json matches RunState schema after a complete workflow run', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-wf-test-')
    const fps = new FakeProcessService()
    const deps = makeIntegrationDeps({ processService: fps })

    const fr = new FakeRunner(fps)
    fr.script({ structuredOutput: 'validated' })
    const STEP = step.define('validate-me', { agent: fr })

    const wf = workflow('schema-check', async (run) => {
      await run(STEP)
    })
    await wf.execute(deps)

    const raw = await fs.readFile(`${tmpDir}/${deps.runId}/state.json`, 'utf-8')
    const parsed = JSON.parse(raw)

    const RunStateSchema = z.object({
      schemaVersion: z.literal(5),
      id: z.string().regex(/^r-\d{4}-\d{2}-\d{2}-[a-z0-9]{6}$/),
      status: z.enum(['running', 'completed', 'crashed']),
      workflowName: z.string().optional(),
      startedAt: z.number(),
      endedAt: z.number().optional(),
      steps: z.record(
        z.string(),
        z.object({
          name: z.string().min(1),
          value: z.unknown(),
          startedAt: z.number(),
          endedAt: z.number(),
          artifacts: z.array(z.string()),
          preRunSnapshot: z.object({ headSha: z.string() }).optional(),
          validations: z.array(
            z.object({
              name: z.string(),
              ok: z.boolean(),
              reason: z.string().optional(),
              hint: z.string().optional(),
            }),
          ),
        }),
      ),
    })

    const result = RunStateSchema.safeParse(parsed)
    expect(result.success).toBe(true)
  })
})
