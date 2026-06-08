import { describe, expect, it } from 'bun:test'
import type { StepName } from '../../../../src/core/types.ts'
import type { StepLifecycleEvent } from '../../../../src/core/workflow.ts'
import { createCompositeHost } from '../../../../src/hosts/composite/index.ts'
import type { RunnerEvent, TranscriptLine } from '../../../../src/runners/index.ts'
import { createFakeHost } from '../../../_support/fake-host.ts'

const STEP = 'plan' as StepName

describe('createCompositeHost', () => {
  it('fans onLifecycleEvent to both primary and secondary', () => {
    const primary = createFakeHost({ mode: 'plain' })
    const secondary = createFakeHost({ mode: 'plain' })
    const composite = createCompositeHost(primary, secondary)

    const event: StepLifecycleEvent = { type: 'step:start', stepName: STEP, mode: 'autonomous' }
    composite.onLifecycleEvent(event)

    expect(primary.recorded).toHaveLength(1)
    expect(primary.recorded[0]).toMatchObject({ kind: 'lifecycle', event })
    expect(secondary.recorded).toHaveLength(1)
    expect(secondary.recorded[0]).toMatchObject({ kind: 'lifecycle', event })
  })

  it('fans onRunnerEvent to both primary and secondary', () => {
    const primary = createFakeHost({ mode: 'plain' })
    const secondary = createFakeHost({ mode: 'plain' })
    const composite = createCompositeHost(primary, secondary)

    const event: RunnerEvent = { kind: 'info', type: 'assistant', payload: {} }
    const lines: readonly TranscriptLine[] = [
      { kind: 'line', category: 'assistant', label: 'assistant>', body: 'hello' },
    ]
    composite.onRunnerEvent(event, STEP, lines)

    expect(primary.recorded).toHaveLength(1)
    expect(primary.recorded[0]).toMatchObject({ kind: 'runner', step: STEP })
    expect(secondary.recorded).toHaveLength(1)
    expect(secondary.recorded[0]).toMatchObject({ kind: 'runner', step: STEP })
  })

  it('fans writeBanner to both primary and secondary', () => {
    const primary = createFakeHost({ mode: 'plain' })
    const secondary = createFakeHost({ mode: 'plain' })
    const composite = createCompositeHost(primary, secondary)

    composite.writeBanner('orch v1.0.0')

    expect(primary.banners).toEqual(['orch v1.0.0'])
    expect(secondary.banners).toEqual(['orch v1.0.0'])
  })

  it('fans onCommandLine to both primary and secondary', () => {
    const primary = createFakeHost({ mode: 'plain' })
    const secondary = createFakeHost({ mode: 'plain' })
    const composite = createCompositeHost(primary, secondary)

    const spec = { stream: 'stdout' as const, line: 'output', step: STEP, pane: 'right' as const }
    composite.onCommandLine(spec)

    expect(primary.recorded).toHaveLength(1)
    expect(primary.recorded[0]).toMatchObject({ kind: 'command-line', spec })
    expect(secondary.recorded).toHaveLength(1)
    expect(secondary.recorded[0]).toMatchObject({ kind: 'command-line', spec })
  })

  it('delegates teardown to primary only; secondary teardown is not called', async () => {
    const primary = createFakeHost({ mode: 'plain' })
    const secondary = createFakeHost({ mode: 'plain' })

    let secondaryTeardownCalled = false
    const secondaryWithSpy: typeof secondary = {
      ...secondary,
      async teardown() {
        secondaryTeardownCalled = true
      },
    }

    const composite = createCompositeHost(primary, secondaryWithSpy)
    await composite.teardown()

    expect(secondaryTeardownCalled).toBe(false)
  })

  it('does not propagate errors thrown by secondary onLifecycleEvent', () => {
    const primary = createFakeHost({ mode: 'plain' })
    const throwing: typeof primary = {
      ...primary,
      onLifecycleEvent(_event: StepLifecycleEvent): void {
        throw new Error('secondary blew up')
      },
    }
    const composite = createCompositeHost(primary, throwing)

    const event: StepLifecycleEvent = { type: 'step:start', stepName: STEP, mode: 'autonomous' }
    expect(() => composite.onLifecycleEvent(event)).not.toThrow()
    expect(primary.recorded).toHaveLength(1)
  })

  it('reports mode from primary', () => {
    const primary = createFakeHost({ mode: 'two-pane' })
    const secondary = createFakeHost({ mode: 'plain' })
    const composite = createCompositeHost(primary, secondary)

    expect(composite.mode).toBe('two-pane')
  })
})
