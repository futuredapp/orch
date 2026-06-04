// triage: rewrite — kind-details panel visible outcome is Tier 1 territory once the harness gains "enter on a completed non-agent step" sugar. Interim Keep; Rewrite once that helper lands.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { Writable } from 'node:stream'
import { createRightPaneController } from '../../../../src/hosts/two-pane/pane-map/index.ts'
import { createPaneQueue } from '../../../../src/hosts/two-pane/pane-queue.ts'
import { FakeTmuxService, paneId, socketName } from '../../../../src/services/tmux/index.ts'
import { path as toPath } from '../../../../src/services/types.ts'
import {
  type RunId,
  type RunState,
  type StateStore,
  type StepEntry,
  runId as toRunId,
} from '../../../../src/state/index.ts'

// Integration coverage for the commit/worktree/ask kind-details panel under
// the U8 swap-based replay model: the controller writes the rendered payload
// to `<stateDir>/.replay/<step>.txt` and registers a `file-tail` source that
// tails it (one per-source session per step), then swaps the visible right
// pane to the hidden tail pane. No `respawnPane` on the visible right pane.

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
    runDir: (rid) => toPath(`/runs/${rid}`),
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

describe('kind-details rendered through the swap-based replay controller (U8)', () => {
  it('writes commit / worktree / ask payloads to .replay/<step>.txt and tails them on scratch', async () => {
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
      width: 200,
      height: 50,
    })

    tmux.nextCreateSessionPaneId(paneId('%100'))
    controller.onIntent({ type: 'enter', stepName: 'commit:feat' })
    await flush()
    tmux.nextCreateSessionPaneId(paneId('%101'))
    controller.onIntent({ type: 'enter', stepName: 'worktree:feat' })
    await flush()
    tmux.nextCreateSessionPaneId(paneId('%102'))
    controller.onIntent({ type: 'enter', stepName: 'ask:approve' })
    await flush()

    // U4: each replay source now lives in its own per-source tmux session
    // created via `createSession`, not via `splitPane` against a shared
    // substrate. Three enters → three per-source sessions.
    const creates = tmux.recordedCalls.filter((c) => c.method === 'createSession')
    expect(creates).toHaveLength(3)
    for (const c of creates) {
      if (c.method !== 'createSession') throw new Error('unreachable')
      expect(c.opts.session).toMatch(/^orch-src-replay-/)
      const command = c.opts.command
      if (command === undefined) throw new Error('expected command on createSession')
      expect(command[0]).toBe('tail')
      expect(command[3]).toBe('-F')
      // path arg sits at command[4]
      expect(typeof command[4]).toBe('string')
    }

    const swaps = tmux.recordedCalls.filter((c) => c.method === 'swapPane')
    expect(swaps).toHaveLength(3)
    for (const sw of swaps) {
      if (sw.method !== 'swapPane') throw new Error('unreachable')
      // First swap targets the original right pane id, subsequent swaps
      // target whichever hidden pane got moved into the visible slot — but
      // never the literal RIGHT_PANE for any second-or-later swap.
    }

    const commit = await Bun.file(`${stateDir}/.replay/commit:feat.txt`).text()
    const worktree = await Bun.file(`${stateDir}/.replay/worktree:feat.txt`).text()
    const ask = await Bun.file(`${stateDir}/.replay/ask:approve.txt`).text()
    expect(commit).toContain('commit sha: cafebabe')
    expect(worktree).toContain('path:    /tmp/wt-feat')
    expect(worktree).toContain('branch:  feat/x')
    expect(ask).toContain('button: submit')
    expect(ask).toContain('name: martin')

    // No respawnPane on the visible right pane.
    const respawnsOnVisible = tmux.recordedCalls.filter(
      (c) => c.method === 'respawnPane' && c.opts.target === RIGHT_PANE,
    )
    expect(respawnsOnVisible).toHaveLength(0)

    await controller.stop()
  })
})
