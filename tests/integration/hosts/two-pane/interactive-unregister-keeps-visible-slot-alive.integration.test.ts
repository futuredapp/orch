// Regression test for the "right pane disappears after the first interactive
// step + replay fails with `can't find pane: %3`" bug observed in run
// `r-2026-05-11-154533-le` (workflow `codex-riddle-solver`).
//
// Trace from that run's lifecycle.ndjson (paraphrased):
//
//   pane-spawned   interactive:write-riddle %3
//   right-pane-swap to=interactive:write-riddle paneId=%3   ← visiblePaneId := %3
//   pane-killed    interactive:write-riddle %3              ← step:complete kills %3
//                                                             but %3 IS the visible
//                                                             slot → right pane gone
//   replay-pane-failed solve-riddle — can't find pane: %3   ← every future swap
//                                                             targets dead %3
//
// Root cause: `killHiddenSource` (right-pane-controller.ts) only swaps the
// visible slot to placeholder when a placeholder source is registered. None
// ever is — the host doesn't register one, and the controller does not
// lazily create one. So when an interactive source is unregistered while
// currently visible, the controller kills the pane that IS the visible slot
// and leaves `visiblePaneId` pointing at a dead pane id.
//
// Contract this test pins:
//
//   - After `unregisterSource({type:'interactive', stepName})` for a source
//     that's currently visible, the controller MUST NOT leave `visiblePaneId`
//     pointing at the killed pane id. A subsequent `showSource(...)` for any
//     other source must issue `swapPane` with a `dst` that's still alive.
//
// The test mirrors the host's wiring as it stands today: it does NOT pre-
// register a placeholder. The fix must come from the controller itself
// (lazy placeholder, defensive kill ordering, etc.) so the contract holds
// regardless of caller wiring.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { Writable } from 'node:stream'
import type { StepName } from '../../../../src/core/types.ts'
import { createRightPaneController } from '../../../../src/hosts/two-pane/pane-map/index.ts'
import { createPaneQueue } from '../../../../src/hosts/two-pane/pane-queue.ts'
import { createNullSessionLogger, type SessionLogger } from '../../../../src/observability/index.ts'
import { FakeTmuxService, paneId, socketName } from '../../../../src/services/tmux/index.ts'
import { path as toPath } from '../../../../src/services/types.ts'
import {
  type RunId,
  type RunState,
  type StateStore,
  type StepEntry,
  runId as toRunId,
} from '../../../../src/state/index.ts'

const RUN_ID: RunId = toRunId('r-2026-05-11-154533-le')
const RIGHT_PANE = paneId('%2')
const LEFT_PANE = paneId('%0')
const HIDDEN_INTERACTIVE = paneId('%3')
const HIDDEN_REPLAY = paneId('%5')
const HIDDEN_PLACEHOLDER = paneId('%4')
const MAIN_SOCKET = socketName('orch-main-int-unreg')
const SCRATCH_SOCKET = socketName('orch-scratch-int-unreg')
const SCRATCH_SESSION = { socket: SCRATCH_SOCKET, session: 'orch-scratch' }

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
    ...(overrides.transcriptPath !== undefined ? { transcriptPath: overrides.transcriptPath } : {}),
  }
}

function makeStore(steps: Record<string, StepEntry>): StateStore {
  const state: RunState = {
    schemaVersion: 5,
    id: RUN_ID,
    status: 'completed',
    workflowName: 'codex-riddle-solver',
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

interface CapturedLog {
  readonly logger: SessionLogger
  readonly entries: Array<{ readonly category: string; readonly record: unknown }>
}

function capturingLogger(stateDir: string): CapturedLog {
  const base = createNullSessionLogger({ runId: RUN_ID })
  const entries: CapturedLog['entries'] = []
  const logger: SessionLogger = {
    ...base,
    logsDir: toPath(`${stateDir}/logs`),
    append: async (category, record): Promise<void> => {
      entries.push({ category, record })
    },
  }
  return { logger, entries }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 0))
  }
}

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp('/tmp/orch-int-unreg-')
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('right-pane-controller — interactive unregister keeps visible slot alive', () => {
  it('leaves visiblePaneId pointing at a live pane so a subsequent replay swap does not target the killed pane', async () => {
    // ----- Arrange -----
    const tmux = new FakeTmuxService()
    // splitPane returns hidden pane ids, FIFO:
    //   1. interactive register → %A (the interactive runner pane)
    //   2. replay register       → %B (the autonomous replay file-tail pane)
    // If the fix lazily spawns a placeholder, that splitPane will consume an
    // id from this queue too; we add a third so the queue doesn't run dry.
    tmux.nextPaneId(HIDDEN_INTERACTIVE)
    tmux.nextPaneId(HIDDEN_PLACEHOLDER)
    tmux.nextPaneId(HIDDEN_REPLAY)

    const stateDir = `${tempDir}/state`
    // Pre-create the autonomous tee so resolveReplaySpec takes the fast path
    // (file-tail over a non-empty tee) and registerSource for the replay key
    // succeeds without writing the JSON fallback.
    const teePath = `${stateDir}/logs/agents/solve-riddle/formatted_output.ansi`
    await mkdir(`${stateDir}/logs/agents/solve-riddle`, { recursive: true })
    await writeFile(teePath, 'persisted-bytes\n', 'utf8')

    const captured = capturingLogger(stateDir)

    const controller = createRightPaneController({
      tmux,
      socket: MAIN_SOCKET,
      leftPaneId: LEFT_PANE,
      rightPaneId: RIGHT_PANE,
      paneQueue: createPaneQueue(),
      stateStore: makeStore({
        'write-riddle': makeStep({
          name: 'write-riddle',
          mode: 'interactive',
          value: { exitCode: 0, durationMs: 1075058, sessionId: 'sess-1' },
        }),
        'solve-riddle': makeStep({
          name: 'solve-riddle',
          mode: 'autonomous',
          value: 'Done.',
          transcriptPath: 'logs/agents/solve-riddle/events.ndjson',
        }),
      }),
      runId: RUN_ID,
      stateDir: toPath(stateDir),
      cwd: toPath(tempDir),
      env: {},
      stderr: bufferStream(),
      scratchSession: SCRATCH_SESSION,
      logger: captured.logger,
    })

    // ----- Act: drive the host's interactive sequence (mirrors tmux-host.ts:824-856) -----
    await controller.registerSource(
      { type: 'interactive', stepName: 'write-riddle' as StepName },
      { kind: 'pty', argv: ['codex'] },
    )
    await controller.showSource({ type: 'interactive', stepName: 'write-riddle' as StepName })
    await flush()
    await controller.unregisterSource({ type: 'interactive', stepName: 'write-riddle' as StepName })
    await flush()

    // User presses Enter on the completed autonomous step (Image #2 scenario).
    controller.onIntent({ type: 'enter', stepName: 'solve-riddle' })
    await flush()

    // ----- Assert -----
    const calls = tmux.recordedCalls

    // Sanity: the interactive hidden pane was killed.
    const killIdx = calls.findIndex(
      (c) => c.method === 'killPane' && c.opts.target === HIDDEN_INTERACTIVE,
    )
    expect(killIdx).toBeGreaterThanOrEqual(0)

    // Core invariant: every swapPane issued AFTER the kill targets a live
    // (non-killed) pane id. The bug today: dst is %A (the just-killed pane).
    const swapsAfterKill = calls.slice(killIdx + 1).flatMap((c) => {
      if (c.method !== 'swapPane') return []
      return [c.opts]
    })
    expect(swapsAfterKill.length).toBeGreaterThan(0)
    for (const swap of swapsAfterKill) {
      expect(swap.dst).not.toBe(HIDDEN_INTERACTIVE)
    }

    // User-visible: no replay-pane-failed event for solve-riddle. Today,
    // the controller logs this record with the "can't find pane" error.
    const failedRecords = captured.entries
      .filter((e) => e.category === 'lifecycle')
      .map((e) => e.record as { readonly type?: string; readonly stepName?: string })
      .filter((r) => r.type === 'replay-pane-failed' && r.stepName === 'solve-riddle')
    expect(failedRecords).toHaveLength(0)

    await controller.stop()
  })
})
