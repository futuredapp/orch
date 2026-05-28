// triage: rewrite — intent→action mapping is Tier 2 (key-intent-mapping.test.tsx); per-kind visible outcome is Tier 1. Rewrite to assert on resulting view shape, not recorded dispatch.
// Unit coverage for the U8 swap-based `onIntent('enter')` dispatch on the
// pane-map controller. The legacy unit-test files
// (right-pane-controller.test.ts, right-pane-follow-live.test.ts,
// right-pane-resume.test.ts, right-pane-busy-gate.test.ts) covered the
// respawn-on-rightPaneId path and were deleted with U8. The integration
// tests under tests/integration/hosts/two-pane/ pin the end-to-end swap
// shape; this file covers the dispatch-layer behavior that isn't naturally
// exercised end-to-end (cached-skip, lookup-miss, warm-cache reuse, error
// banner on dispatch failure).

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { Writable } from 'node:stream'
import type { StepName } from '../../../../../src/core/types.ts'
import {
  createRightPaneController,
  type SourceKey,
} from '../../../../../src/hosts/two-pane/pane-map/index.ts'
import { createPaneQueue } from '../../../../../src/hosts/two-pane/pane-queue.ts'
import type { SessionLogger } from '../../../../../src/observability/index.ts'
import { createNullSessionLogger } from '../../../../../src/observability/index.ts'
import { FakeTmuxService, paneId, socketName } from '../../../../../src/services/tmux/index.ts'
import { path as toPath } from '../../../../../src/services/types.ts'
import {
  type RunId,
  type RunState,
  type StateStore,
  type StepEntry,
  runId as toRunId,
} from '../../../../../src/state/index.ts'

const RUN_ID: RunId = toRunId('r-2026-05-11-200000-oi')
const RIGHT_PANE = paneId('%1')
const LEFT_PANE = paneId('%0')
const SOCKET = socketName('orch-main-on-intent')

const stepName = (s: string): StepName => s as StepName

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
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 0))
  }
}

async function makeController(opts: {
  readonly tempDir: string
  readonly steps: Record<string, StepEntry>
  readonly logger?: SessionLogger
}): Promise<{
  readonly tmux: FakeTmuxService
  readonly stateDir: string
  readonly controller: ReturnType<typeof createRightPaneController>
}> {
  const tmux = new FakeTmuxService()
  const queue = createPaneQueue()
  const stateDir = `${opts.tempDir}/state`
  await mkdir(stateDir, { recursive: true })
  const controller = createRightPaneController({
    tmux,
    socket: SOCKET,
    leftPaneId: LEFT_PANE,
    rightPaneId: RIGHT_PANE,
    paneQueue: queue,
    stateStore: makeStore(opts.steps),
    runId: RUN_ID,
    stateDir: toPath(stateDir),
    cwd: toPath(opts.tempDir),
    env: {},
    stderr: bufferStream(),
    width: 200,
    height: 50,
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
  })
  return { tmux, stateDir, controller }
}

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp('/tmp/orch-on-intent-')
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('right-pane-controller onIntent("enter")', () => {
  it('warm-caches the replay pane: re-enter on the same step does not create a second per-source session', async () => {
    const { tmux, controller, stateDir } = await makeController({
      tempDir,
      steps: {
        'commit:c1': makeStep({ name: 'commit:c1', value: { sha: 'abc' } }),
      },
    })
    void stateDir

    tmux.nextCreateSessionPaneId(paneId('%50'))
    controller.onIntent({ type: 'enter', stepName: 'commit:c1' })
    await flush()
    controller.onIntent({ type: 'enter', stepName: 'commit:c1' })
    await flush()

    const creates = tmux.recordedCalls.filter((c) => c.method === 'createSession')
    expect(creates).toHaveLength(1)
    // showSource on the same currentKey is a no-op — only one swap total.
    const swaps = tmux.recordedCalls.filter((c) => c.method === 'swapPane')
    expect(swaps).toHaveLength(1)

    await controller.stop()
  })

  it('flips viewMode to replay on successful enter', async () => {
    const captured = capturingLogger()
    const { tmux, controller } = await makeController({
      tempDir,
      steps: {
        'commit:c1': makeStep({ name: 'commit:c1', value: { sha: 'abc' } }),
      },
      logger: captured.logger,
    })
    void tmux

    controller.onIntent({ type: 'enter', stepName: 'commit:c1' })
    await flush()

    const viewChange = captured.entries
      .filter((e) => e.category === 'lifecycle')
      .map(
        (e) => e.record as { readonly type?: string; readonly view?: { readonly mode?: string } },
      )
      .find((r) => r.type === 'view-mode-changed' && r.view?.mode === 'replay')
    expect(viewChange).toBeDefined()

    await controller.stop()
  })

  it('does nothing for an unknown stepName (lookup miss)', async () => {
    const captured = capturingLogger()
    const { tmux, controller } = await makeController({
      tempDir,
      steps: {},
      logger: captured.logger,
    })

    controller.onIntent({ type: 'enter', stepName: 'ghost' })
    await flush()

    expect(tmux.recordedCalls.filter((c) => c.method === 'createSession')).toHaveLength(0)
    expect(tmux.recordedCalls.filter((c) => c.method === 'swapPane')).toHaveLength(0)
    const miss = captured.entries
      .filter((e) => e.category === 'lifecycle')
      .map((e) => e.record as { readonly type?: string })
      .find((r) => r.type === 'replay-lookup-miss')
    expect(miss).toBeDefined()

    await controller.stop()
  })

  it('prefers the persisted ANSI tee for autonomous replay when the file is non-empty', async () => {
    const tmux = new FakeTmuxService()
    const queue = createPaneQueue()
    const stateDir = `${tempDir}/state`
    const teePath = `${stateDir}/logs/agents/plan/formatted_output.ansi`
    await mkdir(`${stateDir}/logs/agents/plan`, { recursive: true })
    await writeFile(teePath, 'persisted-bytes', 'utf8')

    const base = createNullSessionLogger({ runId: RUN_ID })
    const logger: SessionLogger = { ...base, logsDir: toPath(`${stateDir}/logs`) }

    const controller = createRightPaneController({
      tmux,
      socket: SOCKET,
      leftPaneId: LEFT_PANE,
      rightPaneId: RIGHT_PANE,
      paneQueue: queue,
      stateStore: makeStore({
        plan: makeStep({ name: 'plan', mode: 'autonomous' }),
      }),
      runId: RUN_ID,
      stateDir: toPath(stateDir),
      cwd: toPath(tempDir),
      env: {},
      stderr: bufferStream(),
      width: 200,
      height: 50,
      logger,
    })

    tmux.nextCreateSessionPaneId(paneId('%70'))
    controller.onIntent({ type: 'enter', stepName: 'plan' })
    await flush()

    const creates = tmux.recordedCalls.filter((c) => c.method === 'createSession')
    expect(creates).toHaveLength(1)
    const create = creates[0]
    if (create?.method !== 'createSession') throw new Error('expected createSession')
    const command = create.opts.command
    if (command === undefined) throw new Error('expected command on createSession')
    // command shape: ['tail', '-n', '5000', '-F', teePath]
    expect(command[4]).toBe(teePath)

    await controller.stop()
  })

  it('on follow-live with no rollup/live registered swaps to placeholder when one exists', async () => {
    const { tmux, controller } = await makeController({
      tempDir,
      steps: { 'commit:a': makeStep({ name: 'commit:a', value: { sha: 'a' } }) },
    })

    tmux.nextCreateSessionPaneId(paneId('%99'))
    await controller.registerSource({ type: 'placeholder' } satisfies SourceKey, {
      kind: 'file-tail',
      path: toPath('/dev/null'),
    })
    tmux.nextCreateSessionPaneId(paneId('%100'))
    controller.onIntent({ type: 'enter', stepName: 'commit:a' })
    await flush()
    controller.onIntent({ type: 'follow-live' })
    await flush()

    // No respawnPane on the visible right pane at any point.
    const respawnsOnVisible = tmux.recordedCalls.filter(
      (c) => c.method === 'respawnPane' && c.opts.target === RIGHT_PANE,
    )
    expect(respawnsOnVisible).toHaveLength(0)

    await controller.stop()
  })

  it('on enter for a running step (live source registered) swaps to live, not replay', async () => {
    // Reproduces a real failure from run r-2026-05-11-215044-tv:
    // after the user visited a past step's replay, pressing Enter on the
    // running step in the step list emitted only replay-lookup-miss and the
    // right pane stayed on the past replay. A `live:<step>` source is already
    // registered for the running step; dispatchEnter must reuse it instead of
    // routing through the replay path.
    const captured = capturingLogger()
    const tmux = new FakeTmuxService()
    const queue = createPaneQueue()
    const stateDir = `${tempDir}/state`
    await mkdir(stateDir, { recursive: true })
    const teePath = `${stateDir}/solve-riddle.tee`
    await writeFile(teePath, 'live bytes\n', 'utf8')

    const controller = createRightPaneController({
      tmux,
      socket: SOCKET,
      leftPaneId: LEFT_PANE,
      rightPaneId: RIGHT_PANE,
      paneQueue: queue,
      stateStore: makeStore({
        'write-riddle': makeStep({
          name: 'write-riddle',
          mode: 'interactive',
          value: null,
        }),
      }),
      runId: RUN_ID,
      stateDir: toPath(stateDir),
      cwd: toPath(tempDir),
      env: {},
      stderr: bufferStream(),
      width: 200,
      height: 50,
      logger: captured.logger,
    })

    // Simulate the host's `step:start` having registered a live source for
    // the running solve-riddle step.
    tmux.nextCreateSessionPaneId(paneId('%200'))
    await controller.registerSource(
      { type: 'live', stepName: stepName('solve-riddle') } satisfies SourceKey,
      { kind: 'file-tail', path: toPath(teePath) },
    )

    // User opens the past write-riddle replay first.
    tmux.nextCreateSessionPaneId(paneId('%201'))
    controller.onIntent({ type: 'enter', stepName: 'write-riddle' })
    await flush()

    const swapsBefore = tmux.recordedCalls.filter((c) => c.method === 'swapPane').length

    // User presses Enter on the running solve-riddle row.
    controller.onIntent({ type: 'enter', stepName: 'solve-riddle' })
    await flush()

    // Must NOT emit a replay-lookup-miss for solve-riddle.
    const misses = captured.entries
      .filter((e) => e.category === 'lifecycle')
      .map((e) => e.record as { readonly type?: string; readonly stepName?: string })
      .filter((r) => r.type === 'replay-lookup-miss' && r.stepName === 'solve-riddle')
    expect(misses).toHaveLength(0)

    // Must perform a swap back to the live solve-riddle pane.
    const swapsAfter = tmux.recordedCalls.filter((c) => c.method === 'swapPane').length
    expect(swapsAfter).toBeGreaterThan(swapsBefore)

    // Must record a live-pane-opened lifecycle event for symmetry with
    // replay-pane-opened on a completed step.
    const opens = captured.entries
      .filter((e) => e.category === 'lifecycle')
      .map((e) => e.record as { readonly type?: string; readonly stepName?: string })
      .filter((r) => r.type === 'live-pane-opened' && r.stepName === 'solve-riddle')
    expect(opens).toHaveLength(1)

    await controller.stop()
  })

  it('re-entering a completed interactive step stays in replay, not live (run r-2026-05-27-154145-nk)', async () => {
    // The first Enter on an interactive agent step registers its replay source
    // under the `interactive:<step>` key (replayKeyFor). That key is also the
    // one `showCachedRunningSource` reads as its "step is live" signal, so the
    // SECOND Enter used to be misclassified as live: it flipped the footer to
    // `{ mode: 'live' }`, which makes the left pane's committed highlight jump
    // to the last step while the right pane shows the stale leftover pane.
    // A completed step (persisted, hence found by lookupStep) must always
    // replay, pinned — never masquerade as live.
    const captured = capturingLogger()
    const { tmux, controller } = await makeController({
      tempDir,
      steps: {
        draft: makeStep({ name: 'draft', mode: 'interactive', value: null }),
      },
      logger: captured.logger,
    })

    tmux.nextCreateSessionPaneId(paneId('%80'))
    controller.onIntent({ type: 'enter', stepName: 'draft' })
    await flush()
    controller.onIntent({ type: 'enter', stepName: 'draft' })
    await flush()

    const views = captured.entries
      .filter((e) => e.category === 'lifecycle')
      .map(
        (e) => e.record as { readonly type?: string; readonly view?: { readonly mode?: string } },
      )
      .filter((r) => r.type === 'view-mode-changed')
    expect(views.at(-1)?.view?.mode).toBe('replay')

    const liveOpens = captured.entries
      .filter((e) => e.category === 'lifecycle')
      .map((e) => e.record as { readonly type?: string })
      .filter((r) => r.type === 'live-pane-opened')
    expect(liveOpens).toHaveLength(0)

    await controller.stop()
  })
})
