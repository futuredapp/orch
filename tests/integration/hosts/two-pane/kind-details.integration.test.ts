import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { Writable } from 'node:stream'
import { createPaneQueue } from '../../../../src/hosts/two-pane/pane-queue.ts'
import { createRightPaneController } from '../../../../src/hosts/two-pane/right-pane-controller.ts'
import { FakeTmuxService, paneId, socketName } from '../../../../src/services/tmux/index.ts'
import { path as toPath } from '../../../../src/services/types.ts'
import {
  type RunId,
  type RunState,
  type StateStore,
  type StepEntry,
  runId as toRunId,
} from '../../../../src/state/index.ts'

// Integration coverage for the commit/worktree/ask kind-details panel: drive
// the end-to-end controller path with seeded StepEntry values and assert the
// rendered payload reaches `<stateDir>/.replay/<step>.txt` and the controller
// respawns the right pane with `cat <file>` (no window-1).

const RUN_ID: RunId = toRunId('r-2026-05-06-100000-cc')
const RIGHT_PANE = paneId('%1')

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
    setArgs: async () => {
      throw new Error('not implemented')
    },
  }
}

function bufferStream(): NodeJS.WritableStream {
  return new Writable({
    write(_c, _e, cb) {
      cb()
    },
  }) as unknown as NodeJS.WritableStream
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 0))
  }
}

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp('/tmp/orch-rpc-test-')
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('kind-details rendered through the right-pane controller', () => {
  it('writes commit / worktree / ask payloads to .replay/<step>.txt and respawns cat <file>', async () => {
    const tmux = new FakeTmuxService()
    const stateDir = `${tempDir}/state`
    await mkdir(stateDir, { recursive: true })

    const controller = createRightPaneController({
      tmux,
      socket: socketName('orch-kind-1'),
      leftPaneId: paneId('%0'),
      rightPaneId: RIGHT_PANE,
      paneQueue: createPaneQueue(),
      stateStore: makeStore({
        'commit:feat': makeStep({ name: 'commit:feat', value: { sha: 'cafebabe' } }),
        'worktree:feat': makeStep({
          name: 'worktree:feat',
          value: { path: '/tmp/wt-feat', branch: 'feat/x', fromRef: 'main' },
        }),
        'ask:approve': makeStep({
          name: 'ask:approve',
          value: { button: 'submit', name: 'martin' },
        }),
      }),
      runId: RUN_ID,
      stateDir: toPath(stateDir),
      cwd: toPath(tempDir),
      env: {},
      stderr: bufferStream(),
    })

    controller.onIntent({ type: 'enter', stepName: 'commit:feat' })
    await flush()
    controller.onIntent({ type: 'enter', stepName: 'worktree:feat' })
    await flush()
    controller.onIntent({ type: 'enter', stepName: 'ask:approve' })
    await flush()

    const respawns = tmux.recordedCalls.filter((c) => c.method === 'respawnPane')
    expect(respawns).toHaveLength(3)
    for (const r of respawns) {
      if (r?.method !== 'respawnPane') throw new Error('unreachable')
      expect(r.opts.target).toBe(RIGHT_PANE)
      expect(r.opts.argv[0]).toBe('cat')
    }

    const commit = await Bun.file(`${stateDir}/.replay/commit:feat.txt`).text()
    const worktree = await Bun.file(`${stateDir}/.replay/worktree:feat.txt`).text()
    const ask = await Bun.file(`${stateDir}/.replay/ask:approve.txt`).text()
    expect(commit).toContain('commit sha: cafebabe')
    expect(worktree).toContain('path:    /tmp/wt-feat')
    expect(worktree).toContain('branch:  feat/x')
    expect(ask).toContain('button: submit')
    expect(ask).toContain('name: martin')

    await controller.stop()
  })
})
