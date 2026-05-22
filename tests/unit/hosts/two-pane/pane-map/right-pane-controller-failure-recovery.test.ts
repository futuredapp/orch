// Regression coverage for the two bugs observed in run
// r-2026-05-21-141104-5n: an "Enter" on a never-replayed step in a scratch
// session whose current window has filled with hidden panes triggered
//
//   tmux split-window failed (exit 1): no space for new pane
//
// which surfaced two distinct user-visible defects:
//
//   Bug B (rendering): the failure string was written to opts.stderr (the
//     orch parent's fd-2) AND to the overlay banner. fd-2 leaks into the
//     attached tmux client's terminal grid and visibly bleeds across both
//     panes. The overlay banner is the legitimate surface.
//
//   Bug A (capacity): the controller's spawnHiddenPane never retried after
//     "no space for new pane", so the step's replay pane was permanently
//     unreachable until the user dismissed and re-entered.
//
// Fix B: every catch site in right-pane-controller routes failures through
//   logLifecycle + emitBanner only; no raw stderr.write.
// Fix A: spawnHiddenPane detects /no space for new pane/, rotates the
//   scratch session to a fresh window via tmux.newWindow, then retries.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { Writable } from 'node:stream'
import type { StepName } from '../../../../../src/core/types.ts'
import { createRightPaneController } from '../../../../../src/hosts/two-pane/pane-map/index.ts'
import { createPaneQueue } from '../../../../../src/hosts/two-pane/pane-queue.ts'
import {
  FakeTmuxService,
  paneId,
  socketName,
  TmuxCommandError,
  windowId,
} from '../../../../../src/services/tmux/index.ts'
import { path as toPath } from '../../../../../src/services/types.ts'
import {
  type RunId,
  type RunState,
  type StateStore,
  type StepEntry,
  runId as toRunId,
} from '../../../../../src/state/index.ts'

const RUN_ID: RunId = toRunId('r-2026-05-21-141104-5n')
const RIGHT_PANE = paneId('%1')
const LEFT_PANE = paneId('%0')
const SCRATCH_SOCKET = socketName('orch-scratch-fr')
const MAIN_SOCKET = socketName('orch-main-fr')
const SCRATCH_SESSION = { socket: SCRATCH_SOCKET, session: 'orch-scratch' }

const stepName = (s: string): StepName => s as StepName

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

interface CapturingStderr {
  readonly stream: NodeJS.WritableStream
  readonly chunks: string[]
}

function capturingStderr(): CapturingStderr {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString())
      cb()
    },
  }) as unknown as NodeJS.WritableStream
  return { stream, chunks }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 0))
  }
}

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp('/tmp/orch-failure-recovery-')
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

interface Harness {
  readonly tmux: FakeTmuxService
  readonly stderr: CapturingStderr
  readonly overlayPath: string
  readonly controller: ReturnType<typeof createRightPaneController>
}

async function makeHarness(steps: Record<string, StepEntry>): Promise<Harness> {
  const tmux = new FakeTmuxService()
  const queue = createPaneQueue()
  const stateDir = `${tempDir}/state`
  await mkdir(stateDir, { recursive: true })
  const stderr = capturingStderr()
  const overlayPath = `${tempDir}/tui-overlay.ndjson`
  const controller = createRightPaneController({
    tmux,
    socket: MAIN_SOCKET,
    leftPaneId: LEFT_PANE,
    rightPaneId: RIGHT_PANE,
    paneQueue: queue,
    stateStore: makeStore(steps),
    runId: RUN_ID,
    stateDir: toPath(stateDir),
    cwd: toPath(tempDir),
    env: {},
    stderr: stderr.stream,
    scratchSession: SCRATCH_SESSION,
    tuiOverlayPath: toPath(overlayPath),
  })
  return { tmux, stderr, overlayPath, controller }
}

// ---------------------------------------------------------------------------
// Bug B — stderr bleed
// ---------------------------------------------------------------------------

describe('right-pane-controller failed replay dispatch — stderr bleed (Bug B)', () => {
  it('does not write to opts.stderr when registerSource throws during dispatchEnter', async () => {
    const h = await makeHarness({
      'commit:c1': makeStep({ name: 'commit:c1', value: { sha: 'abc' } }),
    })

    h.tmux.nextSplitPaneError(
      new TmuxCommandError(1, 'no space for new pane', 'tmux split-window failed'),
    )

    h.controller.onIntent({ type: 'enter', stepName: 'commit:c1' })
    await flush()

    expect(h.stderr.chunks.join('')).toBe('')

    await h.controller.stop()
  })

  it('still surfaces a banner overlay on a non-recoverable failure', async () => {
    // "can't find pane" is not the recoverable "no space" case — the
    // controller does NOT rotate, so the failure reaches the user-visible
    // banner path. This pins the contract that removing stderr.write didn't
    // also remove the legitimate banner sink.
    const h = await makeHarness({
      'commit:c1': makeStep({ name: 'commit:c1', value: { sha: 'abc' } }),
    })

    h.tmux.nextSplitPaneError(
      new TmuxCommandError(1, "can't find pane: %99", 'tmux split-window failed'),
    )

    h.controller.onIntent({ type: 'enter', stepName: 'commit:c1' })
    await flush()

    const overlayText = await Bun.file(h.overlayPath).text()
    expect(overlayText).toContain('replay failed for commit:c1')
    expect(overlayText).toContain('"kind":"error"')

    await h.controller.stop()
  })
})

// ---------------------------------------------------------------------------
// Bug A — scratch window rotation
// ---------------------------------------------------------------------------

describe('right-pane-controller scratch window rotation (Bug A)', () => {
  it('rotates to a new scratch window when splitPane fails with "no space for new pane", then retries', async () => {
    const h = await makeHarness({
      'commit:c1': makeStep({ name: 'commit:c1', value: { sha: 'abc' } }),
    })

    // First splitPane in the scratch session: window is "full".
    h.tmux.nextSplitPaneError(
      new TmuxCommandError(1, 'no space for new pane', 'tmux split-window failed'),
    )
    // Pre-script a window creation result (deterministic ids).
    h.tmux.nextNewWindowResult({ windowId: windowId('@42'), paneId: paneId('%500') })
    // Second splitPane (after rotation) succeeds and returns this pane id.
    h.tmux.nextPaneId(paneId('%501'))

    h.controller.onIntent({ type: 'enter', stepName: 'commit:c1' })
    await flush()

    // newWindow was created on the scratch session.
    const newWindows = h.tmux.recordedCalls.filter((c) => c.method === 'newWindow')
    expect(newWindows).toHaveLength(1)
    const win = newWindows[0]
    if (win?.method !== 'newWindow') throw new Error('expected newWindow')
    expect(win.opts.session).toBe('orch-scratch')
    expect(win.opts.socket).toBe(SCRATCH_SOCKET)

    // splitPane was called twice — the failed one + the retry.
    const splits = h.tmux.recordedCalls.filter((c) => c.method === 'splitPane')
    expect(splits).toHaveLength(2)

    // Retry pane was swapped into the visible slot — registerSource succeeded.
    const swaps = h.tmux.recordedCalls.filter((c) => c.method === 'swapPane')
    expect(swaps).toHaveLength(1)
    const swap = swaps[0]
    if (swap?.method !== 'swapPane') throw new Error('expected swapPane')
    expect(swap.opts.src).toBe(paneId('%501'))

    // No error banner — the rotation recovered the failure.
    const overlayText = await Bun.file(h.overlayPath).text()
    expect(overlayText).not.toContain('replay failed for commit:c1')

    // And no stderr bleed during rotation either (cross-check on Bug B).
    expect(h.stderr.chunks.join('')).toBe('')

    await h.controller.stop()
  })

  it('does not rotate on unrelated tmux errors (e.g. "can\'t find pane")', async () => {
    const h = await makeHarness({
      'commit:c1': makeStep({ name: 'commit:c1', value: { sha: 'abc' } }),
    })

    h.tmux.nextSplitPaneError(
      new TmuxCommandError(1, "can't find pane: %99", 'tmux split-window failed'),
    )

    h.controller.onIntent({ type: 'enter', stepName: 'commit:c1' })
    await flush()

    // No rotation for an unrelated error — original failure propagates.
    const newWindows = h.tmux.recordedCalls.filter((c) => c.method === 'newWindow')
    expect(newWindows).toHaveLength(0)
    const splits = h.tmux.recordedCalls.filter((c) => c.method === 'splitPane')
    expect(splits).toHaveLength(1)

    // The error banner appears on the overlay.
    const overlayText = await Bun.file(h.overlayPath).text()
    expect(overlayText).toContain('replay failed for commit:c1')

    await h.controller.stop()
  })
})

// ---------------------------------------------------------------------------
// Bug C — completion banner overwriting failure banner
// ---------------------------------------------------------------------------
//
// On `step:failed`, the host runs:
//   1. unregisterSource({type:'live', stepName})  (live → replay transform)
//   2. emitBanner({kind:'error', text:'step X failed'})
//
// (1) internally emits an info banner "step X complete" from the live→replay
// transform when the user was watching this source. With the `pendingRegistra-
// tions` drain, (1) can be slow enough that (2) lands BEFORE the info banner,
// and the info banner then overwrites the error via last-write-wins. The
// `suppressCompletionBanner` option lets the host say "don't emit the
// completion toast for this source — I have a durable error banner instead."

describe('right-pane-controller unregisterSource: suppressCompletionBanner (Bug C)', () => {
  it('still emits the completion banner by default (the live → replay info toast)', async () => {
    const h = await makeHarness({})

    h.tmux.nextPaneId(paneId('%600'))
    const liveKey = { type: 'live' as const, stepName: stepName('plan') }
    await h.controller.registerSource(liveKey, {
      kind: 'file-tail',
      path: toPath(`${tempDir}/plan.ansi`),
    })
    await h.controller.showSource(liveKey)

    await h.controller.unregisterSource(liveKey)

    const overlayText = await Bun.file(h.overlayPath).text()
    expect(overlayText).toContain('"text":"step plan complete"')
    expect(overlayText).toContain('"kind":"info"')

    await h.controller.stop()
  })

  it('skips the completion banner when suppressCompletionBanner is true', async () => {
    const h = await makeHarness({})

    h.tmux.nextPaneId(paneId('%601'))
    const liveKey = { type: 'live' as const, stepName: stepName('plan') }
    await h.controller.registerSource(liveKey, {
      kind: 'file-tail',
      path: toPath(`${tempDir}/plan.ansi`),
    })
    await h.controller.showSource(liveKey)

    await h.controller.unregisterSource(liveKey, { suppressCompletionBanner: true })

    const overlayText = await Bun.file(h.overlayPath).text()
    expect(overlayText).not.toContain('"text":"step plan complete"')
    // View-mode flip still happens — only the toast is skipped.
    expect(overlayText).toContain('"mode":"replay"')

    await h.controller.stop()
  })
})

// Helper kept for future tests that distinguish live vs replay keys by step
// name typing.
void stepName
