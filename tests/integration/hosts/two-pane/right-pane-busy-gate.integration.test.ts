// Integration coverage for the post-U8 invariant: there is no busy gate.
// Past-step Enter is always allowed because the swap model is non-destructive
// (the live source remains registered and intact; Enter swaps the visible
// slot to a separate hidden replay pane). The legacy `isRightPaneBusy` option
// is gone — this test pins the new shape.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { Writable } from 'node:stream'
import type { StepName } from '../../../../src/core/types.ts'
import { createTmuxHost } from '../../../../src/hosts/index.ts'
import { FakeClock, FakeFsService } from '../../../../src/services/index.ts'
import { FakeProcessService } from '../../../../src/services/process/index.ts'
import { FakeTmuxService, paneId } from '../../../../src/services/tmux/index.ts'
import { path as toPath } from '../../../../src/services/types.ts'
import {
  type PersistedWorkflowArgs,
  type RunId,
  type RunState,
  type StateStore,
  type StepEntry,
  runId as toRunId,
} from '../../../../src/state/index.ts'

const RUN_ID: RunId = toRunId('r-2026-05-06-200100-bg')

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
    runDir: (rid) => toPath(`/runs/${rid}`),
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0))
}

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp('/tmp/orch-busy-int-')
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('right-pane: busy-gate removal (U8)', () => {
  it('issues no stray sendKeys footer or respawn-cat on the visible right pane while a step is in flight or after it completes', async () => {
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%1'))

    const basePath = toPath(`${tempDir}/state-base`)
    await mkdir(`${basePath}/${RUN_ID}/steps`, { recursive: true })

    const host = await createTmuxHost({
      tmux,
      processService: new FakeProcessService(),
      clock: new FakeClock(1_700_000_000_000),
      runId: RUN_ID,
      workflowName: 'demo',
      stderr: bufferStream(),
      skipVersionCheck: true,
      skipAttach: true,
      env: {},
      cwd: tempDir,
      fs: new FakeFsService(),
      basePath,
      stateStore: makeStore({ plan: makeStep({ name: 'plan', mode: 'autonomous' }) }),
      disableStepsView: true,
    })

    // Toggle step lifecycle through the host port.
    host.onLifecycleEvent({ type: 'step:start', stepName: 'plan' as StepName, mode: 'autonomous' })
    await flush()
    host.onLifecycleEvent({
      type: 'step:complete',
      stepName: 'plan' as StepName,
      durationMs: 100,
    })
    await flush()

    // Post-U8: there is no busy-gate footer message and no cat-respawn on the
    // visible right pane.
    const catRespawnsOnRight = tmux.recordedCalls.filter(
      (c) =>
        c.method === 'respawnPane' && c.opts.target === paneId('%1') && c.opts.argv[0] === 'cat',
    )
    expect(catRespawnsOnRight).toHaveLength(0)

    const busyFooterSends = tmux.recordedCalls.filter(
      (c) =>
        c.method === 'sendKeys' &&
        c.opts.target === paneId('%1') &&
        c.opts.keys.join('').includes('disabled while step running'),
    )
    expect(busyFooterSends).toHaveLength(0)

    await host.teardown()
  })
})
