// The lifecycle trio (`step:start → step:complete | step:failed`), the
// parallel branch-update supplement, and the duration source all live behind
// `withStepLifecycle`. Before the envelope these were hand-emitted at four
// sites in workflow.ts; now the shape is tested once, here, against the
// envelope's interface. The per-kind executors are exercised by the workflow
// integration suites — they no longer carry lifecycle logic to test.

import { describe, expect, it } from 'bun:test'
import { executionContext } from '../../../src/core/execution-context.ts'
import { withStepLifecycle } from '../../../src/core/step-lifecycle.ts'
import { type StepName, stepName } from '../../../src/core/types.ts'
import type { StepLifecycleEvent } from '../../../src/core/workflow.ts'
import { FakeClock } from '../../../src/services/index.ts'
import type { StepEntry } from '../../../src/state/index.ts'
import { createFakeHost, type FakeHost } from '../../helpers/fake-host.ts'

const KEY = stepName('plan')

function lifecycleEvents(host: FakeHost): readonly StepLifecycleEvent[] {
  return host.recorded
    .filter((r): r is { kind: 'lifecycle'; event: StepLifecycleEvent } => r.kind === 'lifecycle')
    .map((r) => r.event)
}

function makeEntry(key: StepName, value: unknown): StepEntry {
  return {
    name: key,
    value,
    startedAt: 0,
    endedAt: 0,
    artifacts: [],
    validations: [],
    transcriptEventCount: 0,
    transcriptTruncated: false,
  }
}

function ctx(host: FakeHost, clock: FakeClock, overrides?: { trackParallel?: boolean }) {
  return {
    host,
    stepSpan: undefined,
    clock,
    key: KEY,
    mode: 'autonomous' as const,
    trackParallel: overrides?.trackParallel ?? true,
  }
}

// Runs the body inside a parallel() scope so currentParallelDepth() reports 1.
function insideParallel<T>(run: () => Promise<T>): Promise<T> {
  return executionContext.run({ parallelDepth: 1, workflowCwd: undefined }, run)
}

describe('withStepLifecycle', () => {
  it('emits step:start then step:complete with the wall-clock duration when the body resolves', async () => {
    const host = createFakeHost()
    const clock = new FakeClock(1000)

    const product = await withStepLifecycle(ctx(host, clock), async () => {
      clock.advance(50)
      return { value: 'ok', entry: makeEntry(KEY, 'ok') }
    })

    expect(product.value).toBe('ok')
    expect(lifecycleEvents(host)).toEqual([
      { type: 'step:start', stepName: KEY, mode: 'autonomous' },
      { type: 'step:complete', stepName: KEY, durationMs: 50 },
    ])
  })

  it('reports the stamped duration instead of wall-clock when the body stamps the timer', async () => {
    const host = createFakeHost()
    const clock = new FakeClock(1000)

    await withStepLifecycle(ctx(host, clock), async (timer) => {
      clock.advance(50) // wall-clock the envelope would otherwise report
      timer.stamp(2000) // runner-reported session duration wins
      return { value: null, entry: makeEntry(KEY, null) }
    })

    const complete = lifecycleEvents(host).find((e) => e.type === 'step:complete')
    expect(complete).toEqual({ type: 'step:complete', stepName: KEY, durationMs: 2000 })
  })

  it('emits step:start then step:failed carrying the thrown error and rethrows it when the body throws', async () => {
    const host = createFakeHost()
    const clock = new FakeClock(1000)
    const boom = new Error('boom')

    const promise = withStepLifecycle(ctx(host, clock), async () => {
      throw boom
    })

    await expect(promise).rejects.toBe(boom)
    const events = lifecycleEvents(host)
    expect(events[0]).toEqual({ type: 'step:start', stepName: KEY, mode: 'autonomous' })
    expect(events[1]).toEqual({ type: 'step:failed', stepName: KEY, error: boom })
    expect(events).toHaveLength(2)
  })

  it('wraps a tracked parallel step with running and completed branch-updates around the trio', async () => {
    const host = createFakeHost()
    const clock = new FakeClock(1000)

    await insideParallel(() =>
      withStepLifecycle(ctx(host, clock), async () => {
        clock.advance(30)
        return { value: 1, entry: makeEntry(KEY, 1) }
      }),
    )

    expect(lifecycleEvents(host)).toEqual([
      { type: 'step:start', stepName: KEY, mode: 'autonomous', insideParallel: true },
      { type: 'step:parallel-branch-update', stepName: KEY, branchStatus: 'running' },
      { type: 'step:complete', stepName: KEY, durationMs: 30, insideParallel: true },
      {
        type: 'step:parallel-branch-update',
        stepName: KEY,
        branchStatus: 'completed',
        elapsedMs: 30,
      },
    ])
  })

  it('emits a failed branch-update with the elapsed time when a tracked parallel step throws', async () => {
    const host = createFakeHost()
    const clock = new FakeClock(1000)

    const promise = insideParallel(() =>
      withStepLifecycle(ctx(host, clock), async () => {
        clock.advance(15)
        throw new Error('branch failed')
      }),
    )

    await expect(promise).rejects.toThrow('branch failed')
    const branchUpdates = lifecycleEvents(host).filter(
      (e) => e.type === 'step:parallel-branch-update',
    )
    expect(branchUpdates).toEqual([
      { type: 'step:parallel-branch-update', stepName: KEY, branchStatus: 'running' },
      { type: 'step:parallel-branch-update', stepName: KEY, branchStatus: 'failed', elapsedMs: 15 },
    ])
  })

  it('omits all branch-updates when trackParallel is false even inside parallel()', async () => {
    const host = createFakeHost()
    const clock = new FakeClock(1000)

    await insideParallel(() =>
      withStepLifecycle(ctx(host, clock, { trackParallel: false }), async () => ({
        value: null,
        entry: makeEntry(KEY, null),
      })),
    )

    const types = lifecycleEvents(host).map((e) => e.type)
    expect(types).toEqual(['step:start', 'step:complete'])
  })
})
