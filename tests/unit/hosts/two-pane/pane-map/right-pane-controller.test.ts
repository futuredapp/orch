// triage: rewrite — register/show/unregister visible-pane outcomes now covered at Tier 1 (autonomous-live-pane-shows-content, replay-revisit-reuses-pane). Keep idempotency + missing-source paths Tier 1 cannot fail-isolate.
// Unit coverage for the pane-map public methods on the right-pane
// controller. The legacy `onIntent` path stays covered by the existing
// tests in `tests/unit/hosts/two-pane/right-pane-controller.test.ts` and
// the integration tests under `tests/integration/hosts/two-pane/`; this
// file focuses on `registerSource`, `showSource`, `unregisterSource`,
// `followLive`, and the per-source-session substrate that replaced the
// historical `orch-scratch` session.

import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { Writable } from 'node:stream'
import type { StepName } from '../../../../../src/core/types.ts'
import {
  createRightPaneController,
  type SourceKey,
  sanitizeSessionName,
} from '../../../../../src/hosts/two-pane/pane-map/index.ts'
import { createPaneQueue } from '../../../../../src/hosts/two-pane/pane-queue.ts'
import { FakeTmuxService, paneId, socketName } from '../../../../../src/services/tmux/index.ts'
import { path as toPath } from '../../../../../src/services/types.ts'
import {
  type RunId,
  type RunState,
  type StateStore,
  runId as toRunId,
} from '../../../../../src/state/index.ts'

const RUN_ID: RunId = toRunId('r-2026-05-11-100000-pm')
const RIGHT_PANE = paneId('%7')
const LEFT_PANE = paneId('%0')
const SOCKET = socketName('orch-main-test')

const stepName = (s: string): StepName => s as StepName

function bufferStream(): NodeJS.WritableStream {
  return new Writable({
    write(_c, _e, cb) {
      cb()
    },
  }) as unknown as NodeJS.WritableStream
}

function makeStore(): StateStore {
  const state: RunState = {
    schemaVersion: 5,
    id: RUN_ID,
    status: 'running',
    workflowName: 'demo',
    startedAt: 0,
    steps: {},
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

async function makeController(): Promise<{
  readonly tmux: FakeTmuxService
  readonly controller: ReturnType<typeof createRightPaneController>
  readonly tempDir: string
}> {
  const tmux = new FakeTmuxService()
  const queue = createPaneQueue()
  const tempDir = await mkdtemp('/tmp/orch-pane-map-')
  const controller = createRightPaneController({
    tmux,
    socket: SOCKET,
    leftPaneId: LEFT_PANE,
    rightPaneId: RIGHT_PANE,
    paneQueue: queue,
    stateStore: makeStore(),
    runId: RUN_ID,
    stateDir: toPath(tempDir),
    cwd: toPath(tempDir),
    env: {},
    stderr: bufferStream(),
    width: 200,
    height: 50,
  })
  return { tmux, controller, tempDir }
}

async function cleanup(tempDir: string): Promise<void> {
  await rm(tempDir, { recursive: true, force: true })
}

describe('right-pane-controller pane-map: registerSource', () => {
  it('creates a per-source tmux session whose initial pane runs the file-tail argv', async () => {
    const { tmux, controller, tempDir } = await makeController()

    tmux.nextCreateSessionPaneId(paneId('%100'))
    const liveKey: SourceKey = { type: 'live', stepName: stepName('plan') }
    await controller.registerSource(liveKey, {
      kind: 'file-tail',
      path: toPath(`${tempDir}/agents/plan/formatted_output.ansi`),
    })

    const createCalls = tmux.recordedCalls.filter((c) => c.method === 'createSession')
    expect(createCalls).toHaveLength(1)
    const call = createCalls[0]
    if (call?.method !== 'createSession') throw new Error('expected createSession')
    expect(call.opts.session).toBe(sanitizeSessionName('live:plan'))
    expect(call.opts.socket).toBe(SOCKET)
    expect(call.opts.command).toEqual([
      'tail',
      '-n',
      '5000',
      '-F',
      `${tempDir}/agents/plan/formatted_output.ansi`,
    ])
    // Regression: no splitPane in the spawn path — that was the historical
    // "no space for new pane" trigger.
    expect(tmux.recordedCalls.filter((c) => c.method === 'splitPane')).toHaveLength(0)

    await controller.stop()
    await cleanup(tempDir)
  })

  it('creates a per-source tmux session with argv, env, and cwd forwarded verbatim for a pty spec', async () => {
    const { tmux, controller, tempDir } = await makeController()

    tmux.nextCreateSessionPaneId(paneId('%200'))
    const interactiveKey: SourceKey = {
      type: 'interactive',
      stepName: stepName('agent'),
    }
    await controller.registerSource(interactiveKey, {
      kind: 'pty',
      argv: ['claude', '--prompt', 'help'],
      env: { FORCE_COLOR: '3' },
      cwd: toPath(tempDir),
    })

    const createCalls = tmux.recordedCalls.filter((c) => c.method === 'createSession')
    expect(createCalls).toHaveLength(1)
    const call = createCalls[0]
    if (call?.method !== 'createSession') throw new Error('expected createSession')
    expect(call.opts.session).toBe(sanitizeSessionName('interactive:agent'))
    expect(call.opts.command).toEqual(['claude', '--prompt', 'help'])
    expect(call.opts.env).toEqual({ FORCE_COLOR: '3' })
    expect(call.opts.cwd).toBe(toPath(tempDir))

    await controller.stop()
    await cleanup(tempDir)
  })

  it('two distinct sources produce two distinct createSession calls — no shared substrate', async () => {
    const { tmux, controller, tempDir } = await makeController()

    tmux.nextCreateSessionPaneId(paneId('%100'))
    await controller.registerSource(
      { type: 'live', stepName: stepName('step1') },
      { kind: 'file-tail', path: toPath(`${tempDir}/step1.ansi`) },
    )
    tmux.nextCreateSessionPaneId(paneId('%101'))
    await controller.registerSource(
      { type: 'live', stepName: stepName('step2') },
      { kind: 'file-tail', path: toPath(`${tempDir}/step2.ansi`) },
    )

    const sessions = tmux.recordedCalls
      .filter((c) => c.method === 'createSession')
      .map((c) => (c.method === 'createSession' ? c.opts.session : ''))
    expect(sessions).toHaveLength(2)
    expect(new Set(sessions).size).toBe(2)
    // Regression assertion for the per-source design: zero splitPane calls.
    expect(tmux.recordedCalls.filter((c) => c.method === 'splitPane')).toHaveLength(0)

    await controller.stop()
    await cleanup(tempDir)
  })

  it('is idempotent when called twice with the same key', async () => {
    const { tmux, controller, tempDir } = await makeController()

    tmux.nextCreateSessionPaneId(paneId('%100'))
    const liveKey: SourceKey = { type: 'live', stepName: stepName('plan') }
    const spec = {
      kind: 'file-tail' as const,
      path: toPath(`${tempDir}/agents/plan/formatted_output.ansi`),
    }
    await controller.registerSource(liveKey, spec)
    await controller.registerSource(liveKey, spec)

    const createCalls = tmux.recordedCalls.filter((c) => c.method === 'createSession')
    expect(createCalls).toHaveLength(1)

    await controller.stop()
    await cleanup(tempDir)
  })

  it('failure isolation: source B succeeds even when source A fails to create its session', async () => {
    const { tmux, controller, tempDir } = await makeController()

    const { TmuxCommandError } = await import('../../../../../src/services/tmux/index.ts')
    tmux.nextCreateSessionError(
      new TmuxCommandError(1, 'failed to create session', 'tmux new-session failed'),
    )
    const keyA: SourceKey = { type: 'live', stepName: stepName('a') }
    await expect(
      controller.registerSource(keyA, { kind: 'file-tail', path: toPath(`${tempDir}/a.ansi`) }),
    ).rejects.toBeInstanceOf(TmuxCommandError)

    // Source B succeeds — there is no shared substrate for source A's failure
    // to corrupt.
    tmux.nextCreateSessionPaneId(paneId('%201'))
    const keyB: SourceKey = { type: 'live', stepName: stepName('b') }
    await controller.registerSource(keyB, {
      kind: 'file-tail',
      path: toPath(`${tempDir}/b.ansi`),
    })

    // No retry, no rotation: exactly two createSession calls, no newWindow.
    expect(tmux.recordedCalls.filter((c) => c.method === 'createSession')).toHaveLength(2)
    expect(tmux.recordedCalls.filter((c) => c.method === 'newWindow')).toHaveLength(0)
    expect(controller.getPaneId(keyB)).toBe(paneId('%201'))

    await controller.stop()
    await cleanup(tempDir)
  })
})

describe('right-pane-controller pane-map: showSource', () => {
  it('issues swapPane(src=entry.paneId, dst=visible) and updates the visible pane id', async () => {
    const { tmux, controller, tempDir } = await makeController()

    tmux.nextCreateSessionPaneId(paneId('%100'))
    const liveKey: SourceKey = { type: 'live', stepName: stepName('plan') }
    await controller.registerSource(liveKey, {
      kind: 'file-tail',
      path: toPath(`${tempDir}/plan.ansi`),
    })
    await controller.showSource(liveKey)

    const swaps = tmux.recordedCalls.filter((c) => c.method === 'swapPane')
    expect(swaps).toHaveLength(1)
    const swap = swaps[0]
    if (swap?.method !== 'swapPane') throw new Error('expected swapPane')
    expect(swap.opts.src).toBe(paneId('%100'))
    expect(swap.opts.dst).toBe(RIGHT_PANE)

    // After the swap, the controller tracks the hidden pane id as the new
    // visible target. A second showSource of a different source should swap
    // from %100 (now visible) to that other source's hidden id.
    tmux.nextCreateSessionPaneId(paneId('%200'))
    const rollupKey: SourceKey = { type: 'rollup' }
    await controller.registerSource(rollupKey, {
      kind: 'file-tail',
      path: toPath(`${tempDir}/_rollup.ansi`),
    })
    await controller.showSource(rollupKey)

    const swapsAfter = tmux.recordedCalls.filter((c) => c.method === 'swapPane')
    expect(swapsAfter).toHaveLength(2)
    const second = swapsAfter[1]
    if (second?.method !== 'swapPane') throw new Error('expected swapPane')
    expect(second.opts.src).toBe(paneId('%200'))
    expect(second.opts.dst).toBe(paneId('%100'))

    await controller.stop()
    await cleanup(tempDir)
  })

  it('preserves the pane-id-sticky invariant: getPaneId(key) is unchanged after a swap', async () => {
    // swap-pane exchanges contents but pane ids stay attached to processes,
    // so the controller's entry for source A still resolves to A's original
    // pane id after the swap. This is the load-bearing property the
    // controller relies on for all subsequent operations.
    const { tmux, controller, tempDir } = await makeController()

    tmux.nextCreateSessionPaneId(paneId('%100'))
    const key: SourceKey = { type: 'live', stepName: stepName('plan') }
    await controller.registerSource(key, {
      kind: 'file-tail',
      path: toPath(`${tempDir}/plan.ansi`),
    })
    expect(controller.getPaneId(key)).toBe(paneId('%100'))

    await controller.showSource(key)

    expect(controller.getPaneId(key)).toBe(paneId('%100'))

    await controller.stop()
    await cleanup(tempDir)
  })

  it('is a no-op when currentKey already equals the target key', async () => {
    const { tmux, controller, tempDir } = await makeController()

    tmux.nextCreateSessionPaneId(paneId('%100'))
    const liveKey: SourceKey = { type: 'live', stepName: stepName('plan') }
    await controller.registerSource(liveKey, {
      kind: 'file-tail',
      path: toPath(`${tempDir}/plan.ansi`),
    })
    await controller.showSource(liveKey)
    await controller.showSource(liveKey)

    const swaps = tmux.recordedCalls.filter((c) => c.method === 'swapPane')
    expect(swaps).toHaveLength(1)

    await controller.stop()
    await cleanup(tempDir)
  })

  it('logs a miss and does not call swapPane when the key is not registered', async () => {
    const { tmux, controller, tempDir } = await makeController()

    const unregistered: SourceKey = { type: 'live', stepName: stepName('ghost') }
    await controller.showSource(unregistered)

    const swaps = tmux.recordedCalls.filter((c) => c.method === 'swapPane')
    expect(swaps).toHaveLength(0)

    await controller.stop()
    await cleanup(tempDir)
  })
})

describe('right-pane-controller pane-map: unregisterSource', () => {
  it('transforms a live key into a replay key without killing the per-source session', async () => {
    const { tmux, controller, tempDir } = await makeController()

    tmux.nextCreateSessionPaneId(paneId('%100'))
    const liveKey: SourceKey = { type: 'live', stepName: stepName('plan') }
    await controller.registerSource(liveKey, {
      kind: 'file-tail',
      path: toPath(`${tempDir}/plan.ansi`),
    })

    await controller.unregisterSource(liveKey)

    // No session kill on the live → replay transform.
    expect(tmux.recordedCalls.filter((c) => c.method === 'killSession')).toHaveLength(0)
    expect(tmux.recordedCalls.filter((c) => c.method === 'killPane')).toHaveLength(0)

    // Subsequent showSource on the matching replay key should swap to the
    // SAME hidden pane id — the live → replay rekey kept the pane alive.
    const replayKey: SourceKey = { type: 'replay', stepName: stepName('plan') }
    await controller.showSource(replayKey)
    const swap = tmux.recordedCalls.find((c) => c.method === 'swapPane')
    if (swap?.method !== 'swapPane') throw new Error('expected swapPane')
    expect(swap.opts.src).toBe(paneId('%100'))

    await controller.stop()
    await cleanup(tempDir)
  })

  it('kills the per-source session for an interactive key (no warm cache)', async () => {
    const { tmux, controller, tempDir } = await makeController()

    tmux.nextCreateSessionPaneId(paneId('%200'))
    const key: SourceKey = { type: 'interactive', stepName: stepName('agent') }
    await controller.registerSource(key, {
      kind: 'pty',
      argv: ['claude'],
    })

    await controller.unregisterSource(key)

    const kills = tmux.recordedCalls.filter((c) => c.method === 'killSession')
    expect(kills).toHaveLength(1)
    const kill = kills[0]
    if (kill?.method !== 'killSession') throw new Error('expected killSession')
    expect(kill.opts.session).toBe(sanitizeSessionName('interactive:agent'))
    expect(kill.opts.socket).toBe(SOCKET)
    // The map entry is gone; getPaneId reports undefined.
    expect(controller.getPaneId(key)).toBeUndefined()

    await controller.stop()
    await cleanup(tempDir)
  })

  it('kills the per-source session for a rollup key', async () => {
    const { tmux, controller, tempDir } = await makeController()

    tmux.nextCreateSessionPaneId(paneId('%300'))
    const key: SourceKey = { type: 'rollup' }
    await controller.registerSource(key, {
      kind: 'file-tail',
      path: toPath(`${tempDir}/_rollup.ansi`),
    })

    await controller.unregisterSource(key)

    const kills = tmux.recordedCalls.filter((c) => c.method === 'killSession')
    expect(kills).toHaveLength(1)
    const kill = kills[0]
    if (kill?.method !== 'killSession') throw new Error('expected killSession')
    expect(kill.opts.session).toBe(sanitizeSessionName('rollup'))

    await controller.stop()
    await cleanup(tempDir)
  })
})

// The user's complaint (run r-2026-05-29-104450-sx): a sequential workflow
// stayed pinned to its FIRST step's pane while later steps ran. The desired
// rule: while the user is tracking the live edge, completing the watched step
// must carry the view forward to the next step that starts. Completion is not
// a navigation, so it must not drop the user out of follow-live.
describe('right-pane-controller pane-map: follow-live auto-advance', () => {
  it('auto-advances the visible pane to the next live step when the current live step completes', async () => {
    const { tmux, controller, tempDir } = await makeController()

    tmux.nextCreateSessionPaneId(paneId('%100'))
    const plan: SourceKey = { type: 'live', stepName: stepName('plan') }
    await controller.registerSource(plan, {
      kind: 'file-tail',
      path: toPath(`${tempDir}/plan.ansi`),
    })
    await controller.unregisterSource(plan)

    tmux.nextCreateSessionPaneId(paneId('%200'))
    const refine: SourceKey = { type: 'live', stepName: stepName('refine') }
    await controller.registerSource(refine, {
      kind: 'file-tail',
      path: toPath(`${tempDir}/refine.ansi`),
    })

    // Swap 1: plan into the visible right pane on registration. Swap 2: refine
    // follows the live edge once plan completes — the regression left this
    // second swap absent (refine only emitted a "press f" banner).
    const swaps = tmux.recordedCalls.filter((c) => c.method === 'swapPane')
    expect(swaps).toHaveLength(2)
    const last = swaps[1]
    if (last?.method !== 'swapPane') throw new Error('expected swapPane')
    expect(last.opts.src).toBe(paneId('%200'))

    await controller.stop()
    await cleanup(tempDir)
  })
})

describe('right-pane-controller pane-map: teardownSessions', () => {
  it('issues one killSession per registered source and clears the map', async () => {
    const { tmux, controller, tempDir } = await makeController()

    tmux.nextCreateSessionPaneId(paneId('%100'))
    await controller.registerSource(
      { type: 'live', stepName: stepName('a') },
      { kind: 'file-tail', path: toPath(`${tempDir}/a.ansi`) },
    )
    tmux.nextCreateSessionPaneId(paneId('%101'))
    await controller.registerSource(
      { type: 'interactive', stepName: stepName('b') },
      { kind: 'pty', argv: ['claude'] },
    )
    tmux.nextCreateSessionPaneId(paneId('%102'))
    await controller.registerSource(
      { type: 'rollup' },
      { kind: 'file-tail', path: toPath(`${tempDir}/rollup.ansi`) },
    )

    await controller.teardownSessions()

    const kills = tmux.recordedCalls.filter((c) => c.method === 'killSession')
    expect(kills).toHaveLength(3)
    // After teardown, all entries are gone.
    expect(controller.getPaneId({ type: 'live', stepName: stepName('a') })).toBeUndefined()
    expect(controller.getPaneId({ type: 'rollup' })).toBeUndefined()

    await controller.stop()
    await cleanup(tempDir)
  })

  it('tolerates one entry throwing — the rest still tear down', async () => {
    // FakeTmuxService.killSession does not throw on its own; this test
    // documents the contract that the orchestrator should iterate without
    // an unhandled failure even if one underlying call rejects in real
    // tmux. The adapter's idempotent shape (see
    // tests/unit/services/tmux/tmux-service.test.ts and the real-tmux test
    // pane-map-source-session.real.integration) covers the genuine
    // "session not found" path.
    const { tmux, controller, tempDir } = await makeController()

    tmux.nextCreateSessionPaneId(paneId('%100'))
    await controller.registerSource(
      { type: 'live', stepName: stepName('a') },
      { kind: 'file-tail', path: toPath(`${tempDir}/a.ansi`) },
    )
    tmux.nextCreateSessionPaneId(paneId('%101'))
    await controller.registerSource(
      { type: 'live', stepName: stepName('b') },
      { kind: 'file-tail', path: toPath(`${tempDir}/b.ansi`) },
    )

    await controller.teardownSessions()

    const kills = tmux.recordedCalls.filter((c) => c.method === 'killSession')
    expect(kills).toHaveLength(2)

    await controller.stop()
    await cleanup(tempDir)
  })
})

describe('right-pane-controller pane-map: followLive', () => {
  it('prefers rollup over live sources when both are registered', async () => {
    const { tmux, controller, tempDir } = await makeController()

    tmux.nextCreateSessionPaneId(paneId('%100'))
    await controller.registerSource(
      { type: 'live', stepName: stepName('plan') },
      { kind: 'file-tail', path: toPath(`${tempDir}/plan.ansi`) },
    )
    tmux.nextCreateSessionPaneId(paneId('%200'))
    await controller.registerSource(
      { type: 'rollup' },
      { kind: 'file-tail', path: toPath(`${tempDir}/_rollup.ansi`) },
    )

    await controller.followLive()

    // registerSource for `live` auto-swaps when viewMode is `live` (U5);
    // findLast targets the swap from the explicit `followLive()` call.
    const swap = tmux.recordedCalls.findLast((c) => c.method === 'swapPane')
    if (swap?.method !== 'swapPane') throw new Error('expected swapPane')
    // Rollup hidden pane id is %200 — followLive picks rollup over live.
    expect(swap.opts.src).toBe(paneId('%200'))

    await controller.stop()
    await cleanup(tempDir)
  })

  it('picks the most-recently-registered live source when rollup is absent', async () => {
    const { tmux, controller, tempDir } = await makeController()

    tmux.nextCreateSessionPaneId(paneId('%100'))
    await controller.registerSource(
      { type: 'live', stepName: stepName('plan') },
      { kind: 'file-tail', path: toPath(`${tempDir}/plan.ansi`) },
    )
    tmux.nextCreateSessionPaneId(paneId('%200'))
    await controller.registerSource(
      { type: 'live', stepName: stepName('apply') },
      { kind: 'file-tail', path: toPath(`${tempDir}/apply.ansi`) },
    )

    await controller.followLive()

    // registerSource for `live` auto-swaps when viewMode is `live` (U5);
    // findLast targets the swap from the explicit `followLive()` call.
    const swap = tmux.recordedCalls.findLast((c) => c.method === 'swapPane')
    if (swap?.method !== 'swapPane') throw new Error('expected swapPane')
    // The latest registered live source's hidden pane wins.
    expect(swap.opts.src).toBe(paneId('%200'))

    await controller.stop()
    await cleanup(tempDir)
  })

  it('is a no-op when no rollup, live, or placeholder source is registered', async () => {
    const { tmux, controller, tempDir } = await makeController()

    await controller.followLive()

    const swaps = tmux.recordedCalls.filter((c) => c.method === 'swapPane')
    expect(swaps).toHaveLength(0)

    await controller.stop()
    await cleanup(tempDir)
  })
})

// Reproduces the regression from run r-2026-05-22-170039-0o: three quick
// `command` steps fire `step:start` events in rapid succession, each
// triggering a fire-and-forget `registerSource` from `tmux-host.ts:746`.
// Each registration's auto-swap-on-live block awaits `showSource`, which
// reads `visiblePaneId`, enqueues a swap, then writes `visiblePaneId` AFTER
// the swap. With concurrent invocations the reads all observe the same
// stale `visiblePaneId` before any write commits, so every swap targets the
// original right pane id — chaining is broken and the user sees the first
// live source's content stuck in the visible slot regardless of what step
// the workflow has progressed to.
describe('right-pane-controller pane-map: concurrent registerSource race', () => {
  it('chains dst across concurrent registerSource calls so each swap targets the previously-visible pane id', async () => {
    const { tmux, controller, tempDir } = await makeController()

    tmux.nextCreateSessionPaneId(paneId('%100'))
    tmux.nextCreateSessionPaneId(paneId('%200'))
    tmux.nextCreateSessionPaneId(paneId('%300'))

    const cmd1: SourceKey = { type: 'live', stepName: stepName('cmd1') }
    const cmd2: SourceKey = { type: 'live', stepName: stepName('cmd2') }
    const cmd3: SourceKey = { type: 'live', stepName: stepName('cmd3') }

    const r1 = controller.registerSource(cmd1, {
      kind: 'file-tail',
      path: toPath(`${tempDir}/cmd1.ansi`),
    })
    const r2 = controller.registerSource(cmd2, {
      kind: 'file-tail',
      path: toPath(`${tempDir}/cmd2.ansi`),
    })
    const r3 = controller.registerSource(cmd3, {
      kind: 'file-tail',
      path: toPath(`${tempDir}/cmd3.ansi`),
    })
    await Promise.all([r1, r2, r3])

    const swaps = tmux.recordedCalls.filter((c) => c.method === 'swapPane')
    expect(swaps).toHaveLength(3)
    const s1 = swaps[0]
    const s2 = swaps[1]
    const s3 = swaps[2]
    if (s1?.method !== 'swapPane') throw new Error('expected swapPane')
    if (s2?.method !== 'swapPane') throw new Error('expected swapPane')
    if (s3?.method !== 'swapPane') throw new Error('expected swapPane')

    // First swap is unambiguous: cmd1's pane into the original right pane slot.
    expect(s1.opts.src).toBe(paneId('%100'))
    expect(s1.opts.dst).toBe(RIGHT_PANE)

    // The race-bug symptom: subsequent swaps must chain through the previous
    // src, not reuse the original right pane id. With the buggy code these
    // assertions fail because both later showSource calls read visiblePaneId
    // before the first swap's write commits.
    expect(s2.opts.src).toBe(paneId('%200'))
    expect(s2.opts.dst).toBe(paneId('%100'))

    expect(s3.opts.src).toBe(paneId('%300'))
    expect(s3.opts.dst).toBe(paneId('%200'))

    await controller.stop()
    await cleanup(tempDir)
  })

  it('keeps the final visible-pane bookkeeping consistent when an interactive source races command sources', async () => {
    // Mirrors the user's tic-tac-toe sequence: three command-step live
    // sources auto-swap, then an interactive source's showSource must land
    // on the most-recent live source's pane id, not on the original right
    // pane. The interactive runner explicitly awaits `showSource` itself
    // (`tmux-host.ts:1083`) — but if the earlier concurrent live swaps
    // corrupted the bookkeeping, this final showSource targets a stale dst
    // and the live claude TUI never reaches the visible slot.
    const { tmux, controller, tempDir } = await makeController()

    tmux.nextCreateSessionPaneId(paneId('%100'))
    tmux.nextCreateSessionPaneId(paneId('%200'))
    tmux.nextCreateSessionPaneId(paneId('%300'))
    tmux.nextCreateSessionPaneId(paneId('%400'))

    await Promise.all([
      controller.registerSource(
        { type: 'live', stepName: stepName('cmd1') },
        { kind: 'file-tail', path: toPath(`${tempDir}/cmd1.ansi`) },
      ),
      controller.registerSource(
        { type: 'live', stepName: stepName('cmd2') },
        { kind: 'file-tail', path: toPath(`${tempDir}/cmd2.ansi`) },
      ),
      controller.registerSource(
        { type: 'live', stepName: stepName('cmd3') },
        { kind: 'file-tail', path: toPath(`${tempDir}/cmd3.ansi`) },
      ),
    ])

    const interactive: SourceKey = { type: 'interactive', stepName: stepName('move-1-1-claude') }
    await controller.registerSource(interactive, {
      kind: 'pty',
      argv: ['claude', '--print', 'play'],
      env: {},
      cwd: toPath(tempDir),
    })
    await controller.showSource(interactive)

    const swaps = tmux.recordedCalls.filter((c) => c.method === 'swapPane')
    expect(swaps).toHaveLength(4)
    // Every swap's dst must equal the previous swap's src. This is the
    // controller's load-bearing chaining invariant — the new visible pane
    // id after swap N is exactly the src of swap N, and swap N+1 swaps
    // that out for the next source. With the race-bug all three live
    // swaps observe the same stale dst (the original right pane id), so
    // the chain breaks at swap 2 even though swap 4 may coincidentally
    // line up.
    const srcs = swaps.map((c) => (c.method === 'swapPane' ? c.opts.src : ''))
    const dsts = swaps.map((c) => (c.method === 'swapPane' ? c.opts.dst : ''))
    expect(srcs).toEqual([paneId('%100'), paneId('%200'), paneId('%300'), paneId('%400')])
    expect(dsts).toEqual([RIGHT_PANE, paneId('%100'), paneId('%200'), paneId('%300')])

    await controller.stop()
    await cleanup(tempDir)
  })
})
