import { describe, expect, it } from 'bun:test'
import type { StepName } from '../../../src/core/index.ts'
import type { StepLifecycleEvent } from '../../../src/core/workflow.ts'
import {
  applyEvent,
  type StatusLoopOptions,
  startStatusLoop,
} from '../../../src/observability/index.ts'
import { FakeClock } from '../../../src/services/clock/index.ts'
import {
  FakeTmuxService,
  paneId,
  socketName,
  type TmuxService,
} from '../../../src/services/tmux/index.ts'

const SOCKET = socketName('orch-test')
const PANE = paneId('%7')

function buildOptions(
  overrides: Partial<StatusLoopOptions> & { readonly tmux: TmuxService } & {
    readonly clock: FakeClock
  },
): StatusLoopOptions {
  return {
    socket: SOCKET,
    target: PANE,
    tty: true,
    ...overrides,
  }
}

// Allow tests to await pending renders without guessing timer durations.
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

// ---------------------------------------------------------------------------
// applyEvent — pure state transitions
// ---------------------------------------------------------------------------

describe('applyEvent', () => {
  it('moves a step from absent to running when step:start fires with autonomous mode', () => {
    const live = new Map<string, { status: string; mode?: string; startedAt?: number }>()
    applyEvent(live as Parameters<typeof applyEvent>[0], stepStart('plan', 'autonomous'), 1000)
    expect(live.get('plan')).toEqual({ status: 'running', mode: 'autonomous', startedAt: 1000 })
  })

  it('records interactive status when step:start fires with interactive mode', () => {
    const live = new Map<string, { status: string; mode?: string; startedAt?: number }>()
    applyEvent(
      live as Parameters<typeof applyEvent>[0],
      stepStart('brainstorm', 'interactive'),
      500,
    )
    expect(live.get('brainstorm')).toEqual({
      status: 'interactive',
      mode: 'interactive',
      startedAt: 500,
    })
  })

  it('preserves the earlier startedAt when step:complete fires', () => {
    const live = new Map<string, { status: string; mode?: string; startedAt?: number }>()
    applyEvent(live as Parameters<typeof applyEvent>[0], stepStart('plan', 'autonomous'), 1000)
    applyEvent(
      live as Parameters<typeof applyEvent>[0],
      { type: 'step:complete', stepName: stepNameBrand('plan'), durationMs: 200 },
      2500,
    )
    const plan = live.get('plan')
    expect(plan?.status).toBe('completed')
    expect(plan?.startedAt).toBe(1000)
    expect((plan as { endedAt?: number }).endedAt).toBe(2500)
  })

  it('marks a cached event without touching timestamps', () => {
    const live = new Map<string, { status: string; startedAt?: number }>()
    applyEvent(
      live as Parameters<typeof applyEvent>[0],
      { type: 'step:cached', stepName: stepNameBrand('plan') },
      9999,
    )
    expect(live.get('plan')).toEqual({ status: 'cached' })
  })
})

// ---------------------------------------------------------------------------
// startStatusLoop — renders through FakeTmuxService
// ---------------------------------------------------------------------------

describe('startStatusLoop', () => {
  it('sends a clear-and-redraw sendKeys payload whenever a step:start event arrives', async () => {
    const tmux = new FakeTmuxService()
    const clock = new FakeClock(1000)
    const loop = startStatusLoop(buildOptions({ tmux, clock }))

    loop.onStepEvent(stepStart('plan', 'autonomous'))
    await flushMicrotasks()

    const calls = tmux.recordedCalls.filter((c) => c.method === 'sendKeys')
    expect(calls).toHaveLength(1)
    const keys = calls[0]?.method === 'sendKeys' ? calls[0].opts.keys : []
    expect(keys[0]).toContain('\u001b[2J\u001b[H')
    expect(keys[0]).toContain('● plan')
  })

  it('re-renders on completion with the frozen duration in place of live elapsed', async () => {
    const tmux = new FakeTmuxService()
    const clock = new FakeClock(1000)
    const loop = startStatusLoop(buildOptions({ tmux, clock }))

    loop.onStepEvent(stepStart('plan', 'autonomous'))
    await flushMicrotasks()

    clock.advance(2000)
    loop.onStepEvent({
      type: 'step:complete',
      stepName: stepNameBrand('plan'),
      durationMs: 2000,
    })
    await flushMicrotasks()

    const sendKeysPayloads = tmux.recordedCalls
      .filter((c) => c.method === 'sendKeys')
      .map((c) => (c.method === 'sendKeys' ? (c.opts.keys[0] ?? '') : ''))
    expect(sendKeysPayloads.length).toBeGreaterThanOrEqual(2)
    const last = sendKeysPayloads.at(-1) ?? ''
    expect(last).toContain('✓ plan')
    expect(last).toContain('2s')
  })

  it('stops rendering after stop() is called and ignores subsequent events', async () => {
    const tmux = new FakeTmuxService()
    const clock = new FakeClock(1000)
    const loop = startStatusLoop(buildOptions({ tmux, clock }))

    loop.onStepEvent(stepStart('plan', 'autonomous'))
    await flushMicrotasks()
    loop.stop()

    const beforeStop = tmux.recordedCalls.length
    loop.onStepEvent({
      type: 'step:complete',
      stepName: stepNameBrand('plan'),
      durationMs: 100,
    })
    await flushMicrotasks()

    expect(tmux.recordedCalls.length).toBe(beforeStop)
  })

  it('routes tmux sendKeys failures to the onError hook without throwing to the caller', async () => {
    const errors: unknown[] = []
    const fake = new FakeTmuxService()
    // Overwrite sendKeys on the instance so other methods stay functional.
    ;(fake as unknown as { sendKeys: TmuxService['sendKeys'] }).sendKeys = async () => {
      throw new Error('pane vanished')
    }
    const loop = startStatusLoop(
      buildOptions({ tmux: fake, clock: new FakeClock(0), onError: (e) => errors.push(e) }),
    )

    loop.onStepEvent(stepStart('plan', 'autonomous'))
    await flushMicrotasks()

    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toBe('pane vanished')
  })

  it('exposes the live record list via records() for agent consumers', async () => {
    const tmux = new FakeTmuxService()
    const loop = startStatusLoop(buildOptions({ tmux, clock: new FakeClock(0) }))

    loop.onStepEvent(stepStart('plan', 'interactive'))
    loop.onStepEvent(stepStart('work', 'autonomous'))
    await flushMicrotasks()

    const snapshot = loop.records()
    expect(snapshot.map((r) => r.name)).toEqual(['plan', 'work'])
    expect(snapshot[0]?.status).toBe('interactive')
    expect(snapshot[1]?.status).toBe('running')
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stepNameBrand(name: string): StepName {
  return name as StepName
}

function stepStart(name: string, mode: 'interactive' | 'autonomous'): StepLifecycleEvent {
  return { type: 'step:start', stepName: stepNameBrand(name), mode }
}
