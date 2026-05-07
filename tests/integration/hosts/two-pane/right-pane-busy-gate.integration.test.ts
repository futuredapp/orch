// Integration coverage for the busy-gate seam in tmux-host: when the host
// gets `step:start` + `step:complete` lifecycle events, the inFlight Set is
// flipped under the hood. The controller's `isRightPaneBusy` reads it.
//
// We test the host wiring by toggling lifecycle events through the host port
// and asserting no spurious respawn-pane('cat …') calls are issued by the
// host itself. End-to-end gate behavior is covered by the controller-level
// busy-gate unit tests; this file proves the host's lifecycle plumbing
// doesn't double-fire respawns.

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

describe('right-pane busy gate plumbing in tmux-host', () => {
  it('does not issue stray cat-respawns while a step is in flight or after it completes', async () => {
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
      // Daemon child needs a real bun spawn — disable for this test. The
      // busy-gate-from-controller end-to-end is covered by the unit tests.
      disableStepsView: true,
    })

    // Toggle step lifecycle through the host port. The host wires this into
    // the inFlight Set; nothing on the right pane should respawn-cat.
    host.onLifecycleEvent({ type: 'step:start', stepName: 'plan' as StepName, mode: 'autonomous' })
    await flush()
    host.onLifecycleEvent({
      type: 'step:complete',
      stepName: 'plan' as StepName,
      durationMs: 100,
    })
    await flush()

    const catRespawns = tmux.recordedCalls.filter(
      (c) => c.method === 'respawnPane' && c.opts.argv[0] === 'cat',
    )
    expect(catRespawns).toHaveLength(0)

    await host.teardown()
  })
})
