// Unit coverage for the LifecycleChoreographer — the right-pane choreography
// extracted from `tmux-host.ts`'s inline `onLifecycleEvent`. Every event type
// is exercised through recording fakes (no tmux); the cross-event tests pin
// the FIFO serialization the extraction introduces.
//
// Triage: each test asserts the *ordered* collaborator calls a lifecycle event
// produces. It would fail if the choreographer skipped a tee write, registered
// the wrong source, or reordered unregister-vs-close — so it passes the
// testing-strategy "would this still pass if the behaviour were wrong?" gate.

import { describe, expect, it } from 'bun:test'
import {
  createRecordingCollaborators,
  type RecordingCollaborators,
  type RejectionPlan,
} from '@orch/test/recording-lifecycle-collaborators.ts'
import { stepName } from '../../../../src/core/types.ts'
import {
  createLifecycleChoreographer,
  type LifecycleChoreographer,
  ROLLUP_STEP_NAME,
} from '../../../../src/hosts/two-pane/lifecycle-choreographer.ts'
import { createNullSessionLogger, type SessionLogger } from '../../../../src/observability/index.ts'
import { FakeClock } from '../../../../src/services/clock/index.ts'
import { path as toPath } from '../../../../src/services/types.ts'
import { type RunId, runId as toRunId } from '../../../../src/state/index.ts'

const RUN_ID: RunId = toRunId('r-2026-05-26-000000-aa')
const LOGS_DIR = '/runs/r-2026-05-26-000000-aa/logs'

function teePath(step: string): string {
  return `${LOGS_DIR}/agents/${step}/formatted_output.ansi`
}

function loggerWith(logsDir: string | null): SessionLogger {
  if (logsDir === null) return createNullSessionLogger()
  return { ...createNullSessionLogger(), logsDir: toPath(logsDir) }
}

interface BuildOpts {
  readonly controllerless?: boolean
  readonly logsDir?: string | null
  readonly torndown?: boolean
  readonly onSendError?: (err: unknown) => void
}

function buildChoreographer(
  rec: RecordingCollaborators,
  opts: BuildOpts = {},
): LifecycleChoreographer {
  return createLifecycleChoreographer({
    controller: opts.controllerless === true ? undefined : rec.controller,
    tee: rec.tee,
    logger: loggerWith(opts.logsDir === undefined ? LOGS_DIR : opts.logsDir),
    runId: RUN_ID,
    clock: new FakeClock(1000),
    isTorndown: () => opts.torndown ?? false,
    onSendError: opts.onSendError ?? (() => {}),
  })
}

describe('LifecycleChoreographer — step:start', () => {
  it('opens the tee, writes the starting marker, then registers a live file-tail source for an autonomous step', async () => {
    const rec = createRecordingCollaborators()
    const choreographer = buildChoreographer(rec)

    await choreographer.handle({
      type: 'step:start',
      stepName: stepName('plan'),
      mode: 'autonomous',
    })

    expect(rec.labels()).toEqual(['tee.open', 'tee.write', 'controller.registerSource'])
    const register = rec.calls.find((c) => c.method === 'registerSource')
    if (register?.method !== 'registerSource') throw new Error('expected a registerSource call')
    expect(register.key).toEqual({ type: 'live', stepName: stepName('plan') })
    expect(register.spec).toEqual({ kind: 'file-tail', path: toPath(teePath('plan')) })
  })

  it('emits a no-transcript banner and registers no source when no logs directory is configured', async () => {
    const rec = createRecordingCollaborators()
    const choreographer = buildChoreographer(rec, { logsDir: null })

    await choreographer.handle({
      type: 'step:start',
      stepName: stepName('plan'),
      mode: 'autonomous',
    })

    expect(rec.labels()).toEqual(['tee.open', 'tee.write', 'controller.emitBanner'])
    const banner = rec.calls.find((c) => c.method === 'emitBanner')
    if (banner?.method !== 'emitBanner') throw new Error('expected an emitBanner call')
    expect(banner.banner.kind).toBe('info')
    expect(banner.banner.text).toContain('no transcript captured')
  })

  it('produces no side effects for a non-autonomous step', async () => {
    const rec = createRecordingCollaborators()
    const choreographer = buildChoreographer(rec)

    await choreographer.handle({
      type: 'step:start',
      stepName: stepName('chat'),
      mode: 'interactive',
    })

    expect(rec.calls).toHaveLength(0)
  })
})

describe('LifecycleChoreographer — step:cached', () => {
  it('emits a single cached-no-transcript info banner', async () => {
    const rec = createRecordingCollaborators()
    const choreographer = buildChoreographer(rec)

    await choreographer.handle({ type: 'step:cached', stepName: stepName('build') })

    expect(rec.labels()).toEqual(['controller.emitBanner'])
    const banner = rec.calls.find((c) => c.method === 'emitBanner')
    if (banner?.method !== 'emitBanner') throw new Error('expected an emitBanner call')
    expect(banner.banner.kind).toBe('info')
    expect(banner.banner.text).toContain('cached')
  })
})

describe('LifecycleChoreographer — step:complete', () => {
  it('unregisters the live source before closing the tee', async () => {
    const rec = createRecordingCollaborators()
    const choreographer = buildChoreographer(rec)

    await choreographer.handle({
      type: 'step:complete',
      stepName: stepName('plan'),
      durationMs: 1234,
    })

    expect(rec.labels()).toEqual(['controller.unregisterSource', 'tee.close'])
    const unregister = rec.calls.find((c) => c.method === 'unregisterSource')
    if (unregister?.method !== 'unregisterSource')
      throw new Error('expected an unregisterSource call')
    expect(unregister.key).toEqual({ type: 'live', stepName: stepName('plan') })
  })
})

describe('LifecycleChoreographer — step:failed', () => {
  it('writes the failure summary, unregisters with the completion banner suppressed, emits the error, then closes the tee', async () => {
    const rec = createRecordingCollaborators()
    const choreographer = buildChoreographer(rec)

    await choreographer.handle({
      type: 'step:failed',
      stepName: stepName('plan'),
      error: new Error('boom'),
    })

    expect(rec.labels()).toEqual([
      'tee.write',
      'controller.unregisterSource',
      'controller.emitBanner',
      'tee.close',
    ])
    const write = rec.calls.find((c) => c.method === 'write')
    if (write?.method !== 'write') throw new Error('expected a tee.write call')
    expect(write.payload).toContain('plan')
    expect(write.payload).toContain('boom')

    const unregister = rec.calls.find((c) => c.method === 'unregisterSource')
    if (unregister?.method !== 'unregisterSource')
      throw new Error('expected an unregisterSource call')
    expect(unregister.options).toEqual({ suppressCompletionBanner: true })

    const banner = rec.calls.find((c) => c.method === 'emitBanner')
    if (banner?.method !== 'emitBanner') throw new Error('expected an emitBanner call')
    expect(banner.banner.kind).toBe('error')
    expect(banner.banner.text).toContain('failed')
  })

  it('skips the failure-summary write when the host is already tearing down', async () => {
    const rec = createRecordingCollaborators()
    const choreographer = buildChoreographer(rec, { torndown: true })

    await choreographer.handle({
      type: 'step:failed',
      stepName: stepName('plan'),
      error: new Error('boom'),
    })

    expect(rec.labels()).toEqual([
      'controller.unregisterSource',
      'controller.emitBanner',
      'tee.close',
    ])
    expect(rec.calls.some((c) => c.method === 'write')).toBe(false)
  })
})

describe('LifecycleChoreographer — parallel block', () => {
  it('opens the rollup tee and registers a rollup file-tail source on parallel-start', async () => {
    const rec = createRecordingCollaborators()
    const choreographer = buildChoreographer(rec)

    await choreographer.handle({ type: 'step:parallel-start', blockId: 0 })

    expect(rec.labels()).toEqual(['tee.open', 'controller.registerSource'])
    const open = rec.calls.find((c) => c.method === 'open')
    if (open?.method !== 'open') throw new Error('expected a tee.open call')
    expect(open.step).toBe(ROLLUP_STEP_NAME)
    const register = rec.calls.find((c) => c.method === 'registerSource')
    if (register?.method !== 'registerSource') throw new Error('expected a registerSource call')
    expect(register.key).toEqual({ type: 'rollup' })
    expect(register.spec).toEqual({ kind: 'file-tail', path: toPath(teePath(ROLLUP_STEP_NAME)) })
  })

  it('aggregates every branch update into one rollup snapshot written to the rollup tee', async () => {
    const rec = createRecordingCollaborators()
    const choreographer = buildChoreographer(rec)

    await choreographer.handle({
      type: 'step:parallel-branch-update',
      stepName: stepName('a'),
      branchStatus: 'running',
    })
    await choreographer.handle({
      type: 'step:parallel-branch-update',
      stepName: stepName('b'),
      branchStatus: 'running',
    })

    const writes = rec.calls.filter((c) => c.method === 'write')
    const last = writes.at(-1)
    if (last?.method !== 'write') throw new Error('expected a rollup tee.write call')
    expect(last.step).toBe(ROLLUP_STEP_NAME)
    expect(last.payload).toContain('parallel branches:')
    expect(last.payload).toContain('● a')
    expect(last.payload).toContain('● b')
  })

  it('closes the rollup tee only after unregistering the rollup source on parallel-complete', async () => {
    const rec = createRecordingCollaborators()
    const choreographer = buildChoreographer(rec)

    await choreographer.handle({ type: 'step:parallel-complete', blockId: 0 })

    expect(rec.labels()).toEqual(['controller.unregisterSource', 'tee.close'])
    const unregister = rec.calls.find((c) => c.method === 'unregisterSource')
    if (unregister?.method !== 'unregisterSource')
      throw new Error('expected an unregisterSource call')
    expect(unregister.key).toEqual({ type: 'rollup' })
    const close = rec.calls.find((c) => c.method === 'close')
    if (close?.method !== 'close') throw new Error('expected a tee.close call')
    expect(close.step).toBe(ROLLUP_STEP_NAME)
  })

  it('resets the rollup aggregator so a later parallel block starts with a fresh snapshot', async () => {
    const rec = createRecordingCollaborators()
    const choreographer = buildChoreographer(rec)

    await choreographer.handle({
      type: 'step:parallel-branch-update',
      stepName: stepName('a'),
      branchStatus: 'running',
    })
    await choreographer.handle({ type: 'step:parallel-complete', blockId: 0 })
    await choreographer.handle({
      type: 'step:parallel-branch-update',
      stepName: stepName('b'),
      branchStatus: 'running',
    })

    const writes = rec.calls.filter((c) => c.method === 'write')
    const last = writes.at(-1)
    if (last?.method !== 'write') throw new Error('expected a rollup tee.write call')
    expect(last.payload).toContain('● b')
    expect(last.payload).not.toContain('● a')
  })
})

describe('LifecycleChoreographer — FIFO serialization', () => {
  it("settles an earlier event's full effect sequence before a later event's begins", async () => {
    const rec = createRecordingCollaborators()
    const choreographer = buildChoreographer(rec)

    // Fire both without awaiting — the choreographer must serialize them.
    void choreographer.handle({
      type: 'step:complete',
      stepName: stepName('first'),
      durationMs: 5,
    })
    void choreographer.handle({
      type: 'step:start',
      stepName: stepName('second'),
      mode: 'autonomous',
    })
    await choreographer.quiescent()

    expect(rec.labels()).toEqual([
      'controller.unregisterSource',
      'tee.close',
      'tee.open',
      'tee.write',
      'controller.registerSource',
    ])
  })

  it('keeps processing later events after one event rejects, routing the rejection to onSendError', async () => {
    const seen: unknown[] = []
    const reject: RejectionPlan = (method, callCount) =>
      method === 'registerSource' && callCount === 1 ? new Error('register boom') : undefined
    const rec = createRecordingCollaborators({ reject })
    const choreographer = buildChoreographer(rec, { onSendError: (err) => seen.push(err) })

    await choreographer.handle({
      type: 'step:start',
      stepName: stepName('first'),
      mode: 'autonomous',
    })
    await choreographer.handle({
      type: 'step:start',
      stepName: stepName('second'),
      mode: 'autonomous',
    })
    await choreographer.quiescent()

    expect(seen).toHaveLength(1)
    expect((seen[0] as Error).message).toBe('register boom')
    expect(rec.calls.filter((c) => c.method === 'registerSource')).toHaveLength(2)
  })
})

describe('LifecycleChoreographer — no controller', () => {
  it('still runs the tee effects and never throws when no controller is wired', async () => {
    const rec = createRecordingCollaborators()
    const choreographer = buildChoreographer(rec, { controllerless: true })

    await choreographer.handle({
      type: 'step:start',
      stepName: stepName('plan'),
      mode: 'autonomous',
    })

    expect(rec.labels()).toEqual(['tee.open', 'tee.write'])
  })
})
