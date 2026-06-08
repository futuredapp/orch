// Tests the U7 lifecycle events: `step:parallel-start` and
// `step:parallel-complete` fire around every `parallel(...)` call, with a
// deterministic block id, and bracket the inner branches' `step:start` /
// `step:complete` events in correct order.

import { describe, expect, it } from 'bun:test'
import { createFakeHost, type FakeHost } from '@orch/test/fake-host.ts'
import { parallel } from '../../../src/core/parallel.ts'
import { step } from '../../../src/core/step.ts'
import type { StepLifecycleEvent, WorkflowDeps } from '../../../src/core/workflow.ts'
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

const rid = (s: string): RunId => s as RunId
const BASE = path('/runs')

let depsCounter = 0

function makeDeps(): WorkflowDeps & { host: FakeHost; processService: FakeProcessService } {
  const fs = new FakeFsService()
  const processService = new FakeProcessService()
  const host = createFakeHost()
  depsCounter += 1
  // Distinct run id per test so each gets a fresh state file.
  const seq = String(depsCounter).padStart(6, '0')
  return {
    fsService: fs,
    gitService: new FakeGitService(),
    processService,
    clock: new FakeClock(1000),
    stateStore: new FileStateStore({ fs, basePath: BASE }),
    runId: rid(`r-2026-05-11-${seq}-u7`),
    cwd: path('/workspace'),
    host,
    promptService: new FakePromptService(),
    interactivity: 'interactive' as const,
  } as WorkflowDeps & { host: FakeHost; processService: FakeProcessService }
}

function lifecycle(host: FakeHost): readonly StepLifecycleEvent[] {
  return host.recorded
    .filter((r): r is { kind: 'lifecycle'; event: StepLifecycleEvent } => r.kind === 'lifecycle')
    .map((r) => r.event)
}

describe('parallel() block lifecycle events', () => {
  it('emits one step:parallel-start before the first branch and one step:parallel-complete after the last branch', async () => {
    const deps = makeDeps()

    await workflow('block-lifecycle', async (run) => {
      await parallel(
        ['a', 'b', 'c'],
        (label) => {
          const fr = new FakeRunner(deps.processService)
          fr.script({ structuredOutput: `ok-${label}` })
          const REVIEW = step.define('review', { agent: fr })
          return run(REVIEW, { as: `review-${label}` })
        },
        { concurrency: 3 },
      )
    }).execute(deps)

    const events = lifecycle(deps.host)
    const types = events.map((e) => e.type)

    const startIdx = types.indexOf('step:parallel-start')
    const completeIdx = types.indexOf('step:parallel-complete')
    expect(startIdx).toBeGreaterThanOrEqual(0)
    expect(completeIdx).toBeGreaterThan(startIdx)

    expect(types.filter((t) => t === 'step:parallel-start')).toHaveLength(1)
    expect(types.filter((t) => t === 'step:parallel-complete')).toHaveLength(1)

    // The block start fires before any branch's step:start.
    const firstStepStart = types.indexOf('step:start')
    expect(startIdx).toBeLessThan(firstStepStart)

    // The block complete fires after every branch's step:complete (3 branches).
    const stepCompletes = types
      .map((t, i) => (t === 'step:complete' ? i : -1))
      .filter((i) => i >= 0)
    expect(stepCompletes).toHaveLength(3)
    expect(completeIdx).toBeGreaterThan(stepCompletes[stepCompletes.length - 1] ?? -1)
  })

  it('two sequential parallel blocks emit two pairs with distinct block ids', async () => {
    const deps = makeDeps()

    await workflow('two-blocks', async (run) => {
      const branch = (label: string) => {
        const fr = new FakeRunner(deps.processService)
        fr.script({ structuredOutput: `ok-${label}` })
        const STEP = step.define('work', { agent: fr })
        return run(STEP, { as: `work-${label}` })
      }
      await parallel(['a1', 'a2'], branch, { concurrency: 2 })
      await parallel(['b1', 'b2'], branch, { concurrency: 2 })
    }).execute(deps)

    const events = lifecycle(deps.host)
    const starts = events.filter((e) => e.type === 'step:parallel-start')
    const completes = events.filter((e) => e.type === 'step:parallel-complete')

    expect(starts).toHaveLength(2)
    expect(completes).toHaveLength(2)

    const startBlockIds = starts.map((e) =>
      e.type === 'step:parallel-start' ? e.blockId : Number.NaN,
    )
    const completeBlockIds = completes.map((e) =>
      e.type === 'step:parallel-complete' ? e.blockId : Number.NaN,
    )

    // Distinct, deterministic ids — 0 and 1 in invocation order.
    expect(startBlockIds).toEqual([0, 1])
    expect(completeBlockIds).toEqual([0, 1])
  })

  it('emits start/complete even when a parallel block has zero items', async () => {
    const deps = makeDeps()

    await workflow('empty-block', async (_run) => {
      await parallel([], async () => undefined, { concurrency: 1 })
    }).execute(deps)

    const events = lifecycle(deps.host)
    const types = events.map((e) => e.type)

    // Zero branches, but the block boundaries still fire — hosts that
    // register a rollup source on start must symmetrically unregister on
    // complete or they leak hidden panes.
    expect(types).toEqual(['step:parallel-start', 'step:parallel-complete', 'run:ended'])
  })

  it('emits start/complete even when a branch throws (parallel still settles)', async () => {
    const deps = makeDeps()

    let caught: unknown
    try {
      await workflow('failing-block', async (run) => {
        await parallel(
          ['a', 'b'],
          async (label) => {
            if (label === 'b') throw new Error('branch-b boom')
            const fr = new FakeRunner(deps.processService)
            fr.script({ structuredOutput: 'ok-a' })
            const STEP = step.define('work', { agent: fr })
            return run(STEP, { as: `work-${label}` })
          },
          { concurrency: 2 },
        )
      }).execute(deps)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeDefined()

    const events = lifecycle(deps.host)
    const types = events.map((e) => e.type)

    expect(types.filter((t) => t === 'step:parallel-start')).toHaveLength(1)
    expect(types.filter((t) => t === 'step:parallel-complete')).toHaveLength(1)

    // Complete fires after the branches settle, regardless of failure. The
    // terminal `run:ended` (the failed run settling) follows it — so
    // parallel-complete is the last step-scoped event before run end.
    expect(types.at(-1)).toBe('run:ended')
    expect(types[types.length - 2]).toBe('step:parallel-complete')
  })
})
