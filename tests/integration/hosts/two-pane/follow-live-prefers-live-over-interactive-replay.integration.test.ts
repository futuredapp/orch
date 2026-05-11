// Regression test: pressing `f` (follow-live) after entering a past
// interactive step's replay must swap back to the currently-running
// autonomous live source, not short-circuit on the just-entered interactive
// replay pane.
//
// Trace from `r-2026-05-11-163506-44/logs/lifecycle.ndjson` (the bug):
//
//   right-pane-swap to=live:solve-riddle paneId=%5    (live visible)
//   tui-intent enter write-riddle                     (user navigates away)
//   pane-spawned interactive:write-riddle %6          (re-registered as replay)
//   right-pane-swap to=interactive:write-riddle %6    (replay visible)
//   tui-intent follow-live                            (user presses `f`)
//   [no right-pane-swap]                              ← BUG: stuck on replay
//   tui-intent follow-live                            (user tries again)
//   [no right-pane-swap]                              ← still stuck
//
// Root cause: `dispatchEnter` for an interactive step calls
// `registerSource({type:'interactive', stepName})`. `registerSource` pushes
// any `live`/`interactive` key onto `liveSources`. So after the user enters
// `write-riddle`, `liveSources = ['live:solve-riddle','interactive:write-
// riddle']`. `followLive` reads `liveSources.at(-1)` →
// `interactive:write-riddle`, which equals `currentKey` → `showSource`
// short-circuits.
//
// Contract this test pins: when both an autonomous `{type:'live'}` source
// and an interactive replay source are registered, `follow-live` MUST swap
// to the live source, not the interactive replay.

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

const RUN_ID: RunId = toRunId('r-2026-05-11-163506-44')
const RIGHT_PANE = paneId('%2')
const LEFT_PANE = paneId('%0')
const HIDDEN_INTERACTIVE = paneId('%3')
const HIDDEN_PLACEHOLDER = paneId('%4')
const HIDDEN_LIVE = paneId('%5')
const HIDDEN_INTERACTIVE_REPLAY = paneId('%6')
const MAIN_SOCKET = socketName('orch-main-flv')
const SCRATCH_SOCKET = socketName('orch-scratch-flv')
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
  tempDir = await mkdtemp('/tmp/orch-follow-live-')
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('right-pane-controller — follow-live prefers the running live source over an interactive replay', () => {
  it('after entering a past interactive step replay, pressing follow-live swaps the visible slot back to the live autonomous source', async () => {
    // ----- Arrange -----
    const tmux = new FakeTmuxService()
    // splitPane return order (FIFO):
    //   1. interactive write-riddle (initial registerSource)
    //   2. placeholder (prior fix's ensurePlaceholderRegistered inside killHiddenSource)
    //   3. live solve-riddle (autonomous step:start)
    //   4. interactive write-riddle replay (dispatchEnter re-register)
    tmux.nextPaneId(HIDDEN_INTERACTIVE)
    tmux.nextPaneId(HIDDEN_PLACEHOLDER)
    tmux.nextPaneId(HIDDEN_LIVE)
    tmux.nextPaneId(HIDDEN_INTERACTIVE_REPLAY)

    const stateDir = `${tempDir}/state`
    // resolveReplaySpec writes refusal text to .replay/<step>.txt; ensure
    // the dir is writable.
    await mkdir(`${stateDir}/.replay`, { recursive: true })

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
          value: { exitCode: 0, durationMs: 211746, sessionId: 'sess-1' },
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

    // ----- Act: mirror the host's interactive→autonomous flow -----

    // 1. Interactive write-riddle runs and ends (as in tmux-host.ts runInteractive).
    await controller.registerSource(
      { type: 'interactive', stepName: 'write-riddle' as StepName },
      { kind: 'pty', argv: ['codex'] },
    )
    await controller.showSource({ type: 'interactive', stepName: 'write-riddle' as StepName })
    await flush()
    await controller.unregisterSource({ type: 'interactive', stepName: 'write-riddle' as StepName })
    await flush()

    // 2. Autonomous solve-riddle starts — host registers a live file-tail.
    // The tee file doesn't need to exist for FakeTmux; only its path is
    // shipped to splitPane's argv.
    const teePath = toPath(`${stateDir}/logs/agents/solve-riddle/formatted_output.ansi`)
    await mkdir(`${stateDir}/logs/agents/solve-riddle`, { recursive: true })
    await writeFile(teePath, '', 'utf8')
    await controller.registerSource(
      { type: 'live', stepName: 'solve-riddle' as StepName },
      { kind: 'file-tail', path: teePath },
    )
    await flush()

    // Sanity: the auto-show inside registerSource(live, …) (currentView is
    // 'live' by default) put HIDDEN_LIVE in the visible slot.
    const swapsBeforeEnter = tmux.recordedCalls.filter((c) => c.method === 'swapPane')
    const liveSwap = swapsBeforeEnter.find(
      (c) => c.method === 'swapPane' && c.opts.src === HIDDEN_LIVE,
    )
    expect(liveSwap).toBeDefined()

    // 3. User presses Enter on write-riddle — re-registers interactive replay
    // and swaps it visible (per dispatchEnter at right-pane-controller.ts:489-501).
    controller.onIntent({ type: 'enter', stepName: 'write-riddle' })
    await flush()

    const callsBeforeFollowLive = tmux.recordedCalls.length

    // 4. User presses `f` to return to the running live step.
    controller.onIntent({ type: 'follow-live' })
    await flush()

    // ----- Assert -----
    const callsAfterFollowLive = tmux.recordedCalls.slice(callsBeforeFollowLive)

    // Core invariant: a swapPane targeting HIDDEN_LIVE (%5) as `src` must
    // have been issued after the follow-live intent.
    const liveSwapAfterFollow = callsAfterFollowLive.find(
      (c) => c.method === 'swapPane' && c.opts.src === HIDDEN_LIVE,
    )
    expect(liveSwapAfterFollow).toBeDefined()

    // Lifecycle confirmation: a right-pane-swap to=live:solve-riddle was
    // logged after the follow-live intent. Today the lifecycle is silent for
    // `follow-live` because showSource short-circuits.
    const lifecycleAfter = captured.entries
      .filter((e) => e.category === 'lifecycle')
      .map((e) => e.record as { readonly type?: string; readonly to?: string })
    const followLiveIdx = lifecycleAfter.findIndex(
      (r) =>
        r.type === 'replay-intent' &&
        (r as unknown as { intent?: { type?: string } }).intent?.type === 'follow-live',
    )
    expect(followLiveIdx).toBeGreaterThanOrEqual(0)
    const liveSwapLog = lifecycleAfter
      .slice(followLiveIdx + 1)
      .find((r) => r.type === 'right-pane-swap' && r.to === 'live:solve-riddle')
    expect(liveSwapLog).toBeDefined()

    await controller.stop()
  })
})
