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
import type { PromptStore } from '../../../../src/hosts/two-pane/prompt-store.ts'
import { createNullSessionLogger, type SessionLogger } from '../../../../src/observability/index.ts'
import { FakeClock } from '../../../../src/services/clock/index.ts'
import { path as toPath } from '../../../../src/services/types.ts'
import { type RunId, runId as toRunId } from '../../../../src/state/index.ts'

const RUN_ID: RunId = toRunId('r-2026-05-26-000000-aa')
const LOGS_DIR = '/runs/r-2026-05-26-000000-aa/logs'

const ESC = '\x1b'

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
  /** Override the prompt sink — e.g. a never-resolving store to prove the
   *  FIFO does not head-of-line-block on the persistence write (Group C). */
  readonly promptStore?: PromptStore
}

function buildChoreographer(
  rec: RecordingCollaborators,
  opts: BuildOpts = {},
): LifecycleChoreographer {
  return createLifecycleChoreographer({
    controller: opts.controllerless === true ? undefined : rec.controller,
    tee: rec.tee,
    promptStore: opts.promptStore ?? rec.promptStore,
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
    // From-start so a long prompt's head survives the bounded tail backfill (KTD8).
    expect(register.spec).toEqual({
      kind: 'file-tail',
      path: toPath(teePath('plan')),
      fromStart: true,
    })
  })

  it('writes the prompt preamble (label + escaped prompt + separator) as the first tee bytes when a prompt is carried', async () => {
    const rec = createRecordingCollaborators()
    const choreographer = buildChoreographer(rec)

    await choreographer.handle({
      type: 'step:start',
      stepName: stepName('plan'),
      mode: 'autonomous',
      prompt: `do the thing ${ESC}[2J now`,
    })

    const write = rec.calls.find((c) => c.on === 'tee' && c.method === 'write')
    if (write?.on !== 'tee' || write.method !== 'write')
      throw new Error('expected a tee.write call')
    expect(write.payload.startsWith('prompt:\r\n')).toBe(true)
    expect(write.payload).toContain('do the thing')
    // The control sequence is escaped to a visible glyph, not passed through.
    expect(write.payload).not.toContain(ESC)
    expect(write.payload).toContain('␛')
  })

  it('Covers R8/U5. persists the RAW (unescaped) prompt to the always-on sink for an autonomous step', async () => {
    const rec = createRecordingCollaborators()
    const choreographer = buildChoreographer(rec)

    await choreographer.handle({
      type: 'step:start',
      stepName: stepName('plan'),
      mode: 'autonomous',
      prompt: `do the thing ${ESC}[2J now`,
    })

    const persisted = rec.calls.find((c) => c.on === 'promptStore')
    if (persisted?.on !== 'promptStore') throw new Error('expected a promptStore.write call')
    expect(persisted.step).toBe('plan')
    // RAW: the store keeps the verbatim prompt (escaping/marking happens at
    // display time), so a future display change is never a storage migration.
    expect(persisted.prompt).toBe(`do the thing ${ESC}[2J now`)
    expect(persisted.prompt).toContain(ESC)
  })

  it('Covers R8/U5. persists the prompt to the always-on sink even when file logging is disabled', async () => {
    const rec = createRecordingCollaborators()
    const choreographer = buildChoreographer(rec, { logsDir: null })

    await choreographer.handle({
      type: 'step:start',
      stepName: stepName('plan'),
      mode: 'autonomous',
      prompt: 'persist me regardless of the logger',
    })

    // The sink is independent of the file logger: it writes even on the
    // logsDir === null path that only emits the no-transcript banner (R8).
    const persisted = rec.calls.find((c) => c.on === 'promptStore')
    if (persisted?.on !== 'promptStore') throw new Error('expected a promptStore.write call')
    expect(persisted.prompt).toBe('persist me regardless of the logger')
    expect(rec.calls.some((c) => c.on === 'controller' && c.method === 'emitBanner')).toBe(true)
  })

  it('Covers R8/U5. writes no prompt sink for an interactive step (autonomous-only)', async () => {
    const rec = createRecordingCollaborators()
    const choreographer = buildChoreographer(rec)

    await choreographer.handle({
      type: 'step:start',
      stepName: stepName('chat'),
      mode: 'interactive',
      prompt: 'this prompt must NOT be persisted for an interactive step',
    })

    expect(rec.calls.some((c) => c.on === 'promptStore')).toBe(false)
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

  it('Covers AT-4. injects no prompt preamble for an interactive step even when the prompt is carried', async () => {
    const rec = createRecordingCollaborators()
    const choreographer = buildChoreographer(rec)

    // Interactive steps carry the assembled prompt on step:start (U2) just like
    // autonomous ones — so the ONLY thing keeping the prompt out of the
    // interactive pane is the choreographer's autonomous-only guard. Drop the
    // guard and this goes red (a tee.open/write would appear), which is exactly
    // the regression AT-4 pins.
    await choreographer.handle({
      type: 'step:start',
      stepName: stepName('chat'),
      mode: 'interactive',
      prompt: 'this prompt must NOT leak into the interactive pane',
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
    const write = rec.calls.find((c) => c.on === 'tee' && c.method === 'write')
    if (write?.on !== 'tee' || write.method !== 'write')
      throw new Error('expected a tee.write call')
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

    const writes = rec.calls.filter((c) => c.on === 'tee' && c.method === 'write')
    const last = writes.at(-1)
    if (last?.on !== 'tee' || last.method !== 'write')
      throw new Error('expected a rollup tee.write call')
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

    const writes = rec.calls.filter((c) => c.on === 'tee' && c.method === 'write')
    const last = writes.at(-1)
    if (last?.on !== 'tee' || last.method !== 'write')
      throw new Error('expected a rollup tee.write call')
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

  it('does not head-of-line-block the FIFO on the prompt-store write (Group C)', async () => {
    // A never-resolving store: the persistence write never flushes. If the
    // choreographer `await`ed it, this one slow write would stall the whole
    // FIFO — neither this step's own `registerSource` nor the next step's
    // `step:start` would ever run. Fire-and-forget means both proceed.
    const rec = createRecordingCollaborators()
    const stalledStore: PromptStore = {
      write: () => new Promise<void>(() => {}),
    }
    const choreographer = buildChoreographer(rec, { promptStore: stalledStore })

    // Fire two autonomous step:starts without awaiting; the stalled store must
    // not gate either step's registerSource.
    void choreographer.handle({
      type: 'step:start',
      stepName: stepName('first'),
      mode: 'autonomous',
      prompt: 'first prompt',
    })
    void choreographer.handle({
      type: 'step:start',
      stepName: stepName('second'),
      mode: 'autonomous',
      prompt: 'second prompt',
    })
    // Flush microtasks (a macrotask hop). With the fix both events fully process;
    // without it, the first event suspends forever on the store write and the
    // second never starts — so this assertion would see zero registerSource calls.
    await new Promise((resolve) => setTimeout(resolve, 0))

    const registered = rec.calls
      .filter((c) => c.on === 'controller' && c.method === 'registerSource')
      .map((c) => (c.method === 'registerSource' ? c.key : undefined))
    expect(registered).toEqual([
      { type: 'live', stepName: stepName('first') },
      { type: 'live', stepName: stepName('second') },
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
