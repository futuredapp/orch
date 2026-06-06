// U4 R20 — `StepNameCollisionError` detection in `runStepOnce`. `runWorkflow`
// (U5) is the real producer of sub frames and `subCallId` tokens; this
// suite simulates that frame via `executionContext.run(...)` so the
// collision predicate can be exercised in isolation. The behavioral
// integration story (collision propagating through a real `runWorkflow`
// invocation) lives in U5's tests.

import { describe, expect, it } from 'bun:test'
import { createFakeHost } from '@orch/test/fake-host.ts'
import { executionContext } from '../../../src/core/execution-context.ts'
import { step } from '../../../src/core/step.ts'
import { type WorkflowDeps, workflow } from '../../../src/core/workflow.ts'
import { defineRunner, type Runner, type RunnerContext } from '../../../src/runners/index.ts'
import {
  FakeClock,
  FakeFsService,
  FakeGitService,
  FakeProcessService,
  path,
} from '../../../src/services/index.ts'
import { FakePromptService } from '../../../src/services/prompt/index.ts'
import { FileStateStore, type RunId } from '../../../src/state/index.ts'

const rid = (s: string): RunId => s as RunId

function makeDeps(): WorkflowDeps {
  const fs = new FakeFsService()
  return {
    fsService: fs,
    gitService: new FakeGitService(),
    processService: new FakeProcessService(),
    clock: new FakeClock(1000),
    stateStore: new FileStateStore({ fs, basePath: path('/runs') }),
    runId: rid('r-2026-05-28-100001-aa'),
    cwd: path('/workspace'),
    host: createFakeHost(),
    promptService: new FakePromptService(),
    interactivity: 'interactive' as const,
  }
}

function silentRunner(deps: WorkflowDeps, name: string): Runner {
  const argv = [`:${name}:`] as const
  const terminal = JSON.stringify({ kind: 'terminal', type: 'turn-complete', data: 'ok' })
  for (let i = 0; i < 20; i++) {
    ;(deps.processService as FakeProcessService)
      .when(argv)
      .respondWith({ stdout: [terminal], exitCode: 0 })
  }
  return defineRunner({
    name,
    supports: { interactive: false, structuredOutput: false },
    buildCommand(ctx: RunnerContext) {
      return { argv: [...argv], env: ctx.env }
    },
    parseEvents(line: string) {
      if (line.trim() === '') return null
      return JSON.parse(line)
    },
    extractStructuredOutput() {
      return 'ok'
    },
    toTranscriptLines() {
      return []
    },
  })
}

describe('runStepOnce — sub-aware cache key', () => {
  it('keys a step run inside a sub under `<sub>>name` when the ALS frame carries a subPath', async () => {
    const deps = makeDeps()
    const PLAN = step.define('plan', { agent: silentRunner(deps, 'r1'), prompt: 'x' })

    const wf = workflow('test', async (run) => {
      // Simulate the sub frame `runWorkflow` will push in U5.
      await executionContext.run(
        {
          ...executionContext.getStore(),
          parallelDepth: 0,
          subworkflowPath: ['simple-feature'],
          subworkflowDepth: 1,
          subCallId: 'call-1',
        },
        async () => {
          await run(PLAN)
        },
      )
    })

    await wf.execute(deps)

    const state = await deps.stateStore.loadRun(deps.runId)
    expect(Object.keys(state?.steps ?? {})).toEqual(['simple-feature>plan'])
    expect(state?.steps['simple-feature>plan']?.subPath).toEqual(['simple-feature'])
    expect(state?.steps['simple-feature>plan']?.subCallId).toBe('call-1')
  })

  it('keeps two same-named steps in different subs as distinct cache entries', async () => {
    const deps = makeDeps()
    const PLAN = step.define('plan', { agent: silentRunner(deps, 'r2'), prompt: 'x' })

    const wf = workflow('test', async (run) => {
      await executionContext.run(
        {
          ...executionContext.getStore(),
          parallelDepth: 0,
          subworkflowPath: ['simple-feature'],
          subworkflowDepth: 1,
          subCallId: 'call-A',
        },
        async () => {
          await run(PLAN)
        },
      )
      await executionContext.run(
        {
          ...executionContext.getStore(),
          parallelDepth: 0,
          subworkflowPath: ['complex-feature'],
          subworkflowDepth: 1,
          subCallId: 'call-B',
        },
        async () => {
          await run(PLAN)
        },
      )
    })

    await wf.execute(deps)

    const state = await deps.stateStore.loadRun(deps.runId)
    const keys = Object.keys(state?.steps ?? {}).sort()
    expect(keys).toEqual(['complex-feature>plan', 'simple-feature>plan'])
  })

  it('throws StepNameCollisionError when the same sub-path is entered twice with different subCallIds', async () => {
    const deps = makeDeps()
    const PLAN = step.define('plan', { agent: silentRunner(deps, 'r3'), prompt: 'x' })

    let caught: unknown
    const wf = workflow('test', async (run) => {
      await executionContext.run(
        {
          ...executionContext.getStore(),
          parallelDepth: 0,
          subworkflowPath: ['simple-feature'],
          subworkflowDepth: 1,
          subCallId: 'call-1',
        },
        async () => {
          await run(PLAN)
        },
      )
      try {
        await executionContext.run(
          {
            ...executionContext.getStore(),
            parallelDepth: 0,
            subworkflowPath: ['simple-feature'],
            subworkflowDepth: 1,
            subCallId: 'call-2', // DIFFERENT subCallId — case (b) of R20.
          },
          async () => {
            await run(PLAN)
          },
        )
      } catch (err) {
        caught = err
      }
    })

    await wf.execute(deps)

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).name).toBe('StepNameCollisionError')
    expect((caught as Error).message).toContain('plan')
    // The first sub's prior result remains; the colliding second write is rejected.
    const state = await deps.stateStore.loadRun(deps.runId)
    expect(state?.steps['simple-feature>plan']?.subCallId).toBe('call-1')
  })

  it('does NOT throw on a second call with the SAME subCallId (legitimate cache replay)', async () => {
    const deps = makeDeps()
    const PLAN = step.define('plan', { agent: silentRunner(deps, 'r4'), prompt: 'x' })

    const wf = workflow('test', async (run) => {
      await executionContext.run(
        {
          ...executionContext.getStore(),
          parallelDepth: 0,
          subworkflowPath: ['s'],
          subworkflowDepth: 1,
          subCallId: 'same',
        },
        async () => {
          await run(PLAN)
          await run(PLAN) // second call — cache hit, no save.
        },
      )
    })

    await wf.execute(deps)

    const state = await deps.stateStore.loadRun(deps.runId)
    expect(Object.keys(state?.steps ?? {})).toEqual(['s>plan'])
  })

  it('records `insideParallel: true` on the entry when the ALS frame is inside a parallel branch', async () => {
    const deps = makeDeps()
    const PLAN = step.define('plan', { agent: silentRunner(deps, 'r5'), prompt: 'x' })

    const wf = workflow('test', async (run) => {
      await executionContext.run(
        {
          ...executionContext.getStore(),
          parallelDepth: 1,
          insideParallel: true,
        },
        async () => {
          await run(PLAN)
        },
      )
    })

    await wf.execute(deps)

    const state = await deps.stateStore.loadRun(deps.runId)
    expect(state?.steps.plan?.insideParallel).toBe(true)
  })

  it('omits subPath/subCallId/insideParallel from root-frame entries (back-compat)', async () => {
    const deps = makeDeps()
    const PLAN = step.define('plan', { agent: silentRunner(deps, 'r6'), prompt: 'x' })

    const wf = workflow('test', async (run) => {
      await run(PLAN)
    })

    await wf.execute(deps)

    const state = await deps.stateStore.loadRun(deps.runId)
    const entry = state?.steps.plan
    expect(entry).toBeDefined()
    expect(entry?.subPath).toBeUndefined()
    expect(entry?.subCallId).toBeUndefined()
    expect(entry?.insideParallel).toBeUndefined()
  })
})
