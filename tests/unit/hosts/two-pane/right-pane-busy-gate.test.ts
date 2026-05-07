// Unit coverage for the right-pane-controller's busy gate. While a step is
// in flight on the right pane (autonomous transcript flowing OR interactive
// agent live), Enter must be a no-op with a footer message instead of
// clobbering the live content via respawn-pane.

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

const RUN_ID: RunId = toRunId('r-2026-05-06-100100-bg')
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
    ...(overrides.mode !== undefined ? { mode: overrides.mode } : {}),
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
  readonly stateDir: string
  readonly setBusy: (b: boolean) => void
  readonly stop: () => Promise<void>
  readonly onIntent: ReturnType<typeof createRightPaneController>['onIntent']
}

async function makeBusyController(opts: {
  readonly tempDir: string
  readonly steps: Record<string, StepEntry>
  readonly initialBusy: boolean
  readonly logger?: SessionLogger
}): Promise<Harness> {
  const tmux = new FakeTmuxService()
  const queue = createPaneQueue()
  const stateDir = `${opts.tempDir}/state`
  await mkdir(stateDir, { recursive: true })
  let busy = opts.initialBusy
  const controller = createRightPaneController({
    tmux,
    socket: socketName('orch-busy'),
    leftPaneId: paneId('%0'),
    rightPaneId: RIGHT_PANE,
    paneQueue: queue,
    stateStore: makeStore(opts.steps),
    runId: RUN_ID,
    stateDir: toPath(stateDir),
    cwd: toPath(opts.tempDir),
    env: {},
    stderr: bufferStream(),
    isRightPaneBusy: () => busy,
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
  })
  return {
    tmux,
    stateDir,
    setBusy: (v) => {
      busy = v
    },
    stop: () => controller.stop(),
    onIntent: controller.onIntent,
  }
}

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp('/tmp/orch-busy-')
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('right-pane-controller busy gate', () => {
  it('is a no-op when isRightPaneBusy returns true and Enter targets a completed step', async () => {
    const harness = await makeBusyController({
      tempDir,
      initialBusy: true,
      steps: {
        plan: makeStep({ name: 'plan', mode: 'autonomous' }),
      },
    })

    harness.onIntent({ type: 'enter', stepName: 'plan' })
    await flush()

    const respawns = harness.tmux.recordedCalls.filter((c) => c.method === 'respawnPane')
    expect(respawns).toHaveLength(0)

    await harness.stop()
  })

  it('logs replay-blocked-busy with the intents stepName when the gate fires', async () => {
    const captured = capturingLogger()
    const harness = await makeBusyController({
      tempDir,
      initialBusy: true,
      steps: {
        plan: makeStep({ name: 'plan', mode: 'autonomous' }),
      },
      logger: captured.logger,
    })

    harness.onIntent({ type: 'enter', stepName: 'plan' })
    await flush()

    const blocked = captured.entries
      .filter((e) => e.category === 'lifecycle')
      .map((e) => e.record as { readonly type?: string; readonly stepName?: string })
      .find((r) => r.type === 'replay-blocked-busy')
    expect(blocked).toBeDefined()
    expect(blocked?.stepName).toBe('plan')

    await harness.stop()
  })

  it('does not respawn the right pane while the gate is closed', async () => {
    const harness = await makeBusyController({
      tempDir,
      initialBusy: true,
      steps: {
        plan: makeStep({ name: 'plan', mode: 'autonomous' }),
      },
    })

    // Three Enter intents — none should respawn while the gate is closed.
    harness.onIntent({ type: 'enter', stepName: 'plan' })
    harness.onIntent({ type: 'enter', stepName: 'plan' })
    harness.onIntent({ type: 'enter', stepName: 'plan' })
    await flush()

    const respawns = harness.tmux.recordedCalls.filter((c) => c.method === 'respawnPane')
    expect(respawns).toHaveLength(0)

    await harness.stop()
  })

  it('allows Enter once isRightPaneBusy returns false again', async () => {
    const harness = await makeBusyController({
      tempDir,
      initialBusy: true,
      steps: {
        plan: makeStep({ name: 'plan', mode: 'autonomous' }),
      },
    })

    harness.onIntent({ type: 'enter', stepName: 'plan' })
    await flush()
    expect(harness.tmux.recordedCalls.some((c) => c.method === 'respawnPane')).toBe(false)

    harness.setBusy(false)
    harness.onIntent({ type: 'enter', stepName: 'plan' })
    await flush()

    const respawns = harness.tmux.recordedCalls.filter((c) => c.method === 'respawnPane')
    expect(respawns).toHaveLength(1)

    await harness.stop()
  })

  it('writes a footer notice via sendKeys when the gate refuses an Enter', async () => {
    const harness = await makeBusyController({
      tempDir,
      initialBusy: true,
      steps: {
        plan: makeStep({ name: 'plan', mode: 'autonomous' }),
      },
    })

    harness.onIntent({ type: 'enter', stepName: 'plan' })
    await flush()

    const sends = harness.tmux.recordedCalls.filter((c) => c.method === 'sendKeys')
    expect(sends.length).toBeGreaterThan(0)
    const merged = sends.map((c) => (c.method === 'sendKeys' ? c.opts.keys.join('') : '')).join('')
    expect(merged).toContain('disabled while step running')

    await harness.stop()
  })
})
