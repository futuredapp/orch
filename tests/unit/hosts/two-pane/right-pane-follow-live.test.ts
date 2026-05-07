// Unit coverage for the follow-live (`f`) intent. After a prior Enter has
// rendered a replay into the right pane, follow-live must respawn the pane
// back to the `cat` placeholder so the next live runner has a known-good
// target. Without a prior Enter the intent is a no-op.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { Writable } from 'node:stream'
import { createPaneQueue } from '../../../../src/hosts/two-pane/pane-queue.ts'
import { createRightPaneController } from '../../../../src/hosts/two-pane/right-pane-controller.ts'
import type { SessionLogger } from '../../../../src/observability/index.ts'
import { createNullSessionLogger } from '../../../../src/observability/index.ts'
import { FakeTmuxService, paneId, socketName } from '../../../../src/services/tmux/index.ts'
import { path as toPath } from '../../../../src/services/types.ts'
import {
  type PersistedWorkflowArgs,
  type RunId,
  type RunState,
  type StateStore,
  type StepEntry,
  runId as toRunId,
} from '../../../../src/state/index.ts'

const RUN_ID: RunId = toRunId('r-2026-05-06-100100-fl')
const RIGHT_PANE = paneId('%1')

function bufferStream(): NodeJS.WritableStream {
  return new Writable({
    write(_c, _e, cb) {
      cb()
    },
  }) as unknown as NodeJS.WritableStream
}

function makeStep(overrides: Partial<StepEntry> & Pick<StepEntry, 'name'>): StepEntry {
  return {
    name: overrides.name,
    value: overrides.value ?? null,
    startedAt: 1000,
    endedAt: 2000,
    artifacts: [],
    validations: [],
    transcriptEventCount: 0,
    transcriptTruncated: false,
  }
}

function makeStore(steps: Record<string, StepEntry>): StateStore {
  const state: RunState = {
    schemaVersion: 5,
    id: RUN_ID,
    status: 'running',
    workflowName: 'demo',
    startedAt: 0,
    steps,
  }
  return {
    loadRun: async (rid) => (rid === RUN_ID ? state : undefined),
    saveStep: async () => {
      throw new Error('not implemented')
    },
    initRun: async () => {
      throw new Error('not implemented')
    },
    setStatus: async () => {
      throw new Error('not implemented')
    },
    setArgs: async (_rid: RunId, _args: PersistedWorkflowArgs) => {
      throw new Error('not implemented')
    },
  }
}

interface CapturedLog {
  readonly logger: SessionLogger
  readonly entries: Array<{ readonly category: string; readonly record: unknown }>
}

function capturingLogger(): CapturedLog {
  const base = createNullSessionLogger({ runId: RUN_ID })
  const entries: CapturedLog['entries'] = []
  const logger: SessionLogger = {
    ...base,
    append: async (category, record): Promise<void> => {
      entries.push({ category, record })
    },
  }
  return { logger, entries }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0))
}

interface Harness {
  readonly tmux: FakeTmuxService
  readonly stop: () => Promise<void>
  readonly onIntent: ReturnType<typeof createRightPaneController>['onIntent']
}

async function makeFollowLiveController(opts: {
  readonly tempDir: string
  readonly steps: Record<string, StepEntry>
  readonly logger?: SessionLogger
}): Promise<Harness> {
  const tmux = new FakeTmuxService()
  const queue = createPaneQueue()
  const stateDir = `${opts.tempDir}/state`
  await mkdir(stateDir, { recursive: true })
  const controller = createRightPaneController({
    tmux,
    socket: socketName('orch-follow'),
    leftPaneId: paneId('%0'),
    rightPaneId: RIGHT_PANE,
    paneQueue: queue,
    stateStore: makeStore(opts.steps),
    runId: RUN_ID,
    stateDir: toPath(stateDir),
    cwd: toPath(opts.tempDir),
    env: {},
    stderr: bufferStream(),
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
  })
  return { tmux, stop: () => controller.stop(), onIntent: controller.onIntent }
}

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp('/tmp/orch-follow-')
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('right-pane-controller follow-live (f)', () => {
  it('respawns the right pane with the cat placeholder on follow-live after a prior enter', async () => {
    const harness = await makeFollowLiveController({
      tempDir,
      steps: { 'commit:a': makeStep({ name: 'commit:a', value: { sha: 'a' } }) },
    })

    harness.onIntent({ type: 'enter', stepName: 'commit:a' })
    await flush()
    harness.onIntent({ type: 'follow-live' })
    await flush()

    const respawns = harness.tmux.recordedCalls.filter((c) => c.method === 'respawnPane')
    // Two respawns: the Enter (cat <file>) and the follow-live (cat).
    expect(respawns).toHaveLength(2)

    const last = respawns.at(-1)
    if (last?.method !== 'respawnPane') throw new Error('expected respawn')
    expect(last.opts.target).toBe(RIGHT_PANE)
    expect(last.opts.argv).toEqual(['cat'])
    expect(last.opts.killRunning).toBe(true)

    await harness.stop()
  })

  it('is a no-op on follow-live when no prior enter has fired', async () => {
    const harness = await makeFollowLiveController({
      tempDir,
      steps: { 'commit:a': makeStep({ name: 'commit:a', value: { sha: 'a' } }) },
    })

    harness.onIntent({ type: 'follow-live' })
    await flush()

    const respawns = harness.tmux.recordedCalls.filter((c) => c.method === 'respawnPane')
    expect(respawns).toHaveLength(0)

    await harness.stop()
  })

  it('emits replay-pane-closing on follow-live', async () => {
    const captured = capturingLogger()
    const harness = await makeFollowLiveController({
      tempDir,
      steps: { 'commit:a': makeStep({ name: 'commit:a', value: { sha: 'a' } }) },
      logger: captured.logger,
    })

    harness.onIntent({ type: 'enter', stepName: 'commit:a' })
    await flush()
    harness.onIntent({ type: 'follow-live' })
    await flush()

    const closing = captured.entries
      .filter((e) => e.category === 'lifecycle')
      .map((e) => e.record as { readonly type?: string })
      .find((r) => r.type === 'replay-pane-closing')
    expect(closing).toBeDefined()

    await harness.stop()
  })
})
