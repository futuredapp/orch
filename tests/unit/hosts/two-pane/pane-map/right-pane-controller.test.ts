// Unit coverage for the NEW pane-map public methods on the right-pane
// controller. The legacy `onIntent` path stays covered by the existing
// tests in `tests/unit/hosts/two-pane/right-pane-controller.test.ts` and
// the integration tests under `tests/integration/hosts/two-pane/`; this
// file focuses on `registerSource`, `showSource`, `unregisterSource`,
// `followLive`, and the scratch-session contract.

import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { Writable } from 'node:stream'
import type { StepName } from '../../../../../src/core/types.ts'
import {
  createRightPaneController,
  type SourceKey,
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
const SCRATCH_SOCKET = socketName('orch-scratch-test')
const MAIN_SOCKET = socketName('orch-main-test')
const SCRATCH_SESSION = { socket: SCRATCH_SOCKET, session: 'orch-scratch' }

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
    socket: MAIN_SOCKET,
    leftPaneId: LEFT_PANE,
    rightPaneId: RIGHT_PANE,
    paneQueue: queue,
    stateStore: makeStore(),
    runId: RUN_ID,
    stateDir: toPath(tempDir),
    cwd: toPath(tempDir),
    env: {},
    stderr: bufferStream(),
    scratchSession: SCRATCH_SESSION,
  })
  return { tmux, controller, tempDir }
}

async function cleanup(tempDir: string): Promise<void> {
  await rm(tempDir, { recursive: true, force: true })
}

describe('right-pane-controller pane-map: registerSource', () => {
  it('spawns a file-tail hidden pane on the scratch session with the expected argv', async () => {
    const { tmux, controller, tempDir } = await makeController()

    tmux.nextPaneId(paneId('%100'))
    const liveKey: SourceKey = { type: 'live', stepName: stepName('plan') }
    await controller.registerSource(liveKey, {
      kind: 'file-tail',
      path: toPath(`${tempDir}/agents/plan/formatted_output.ansi`),
    })

    const splitCalls = tmux.recordedCalls.filter((c) => c.method === 'splitPane')
    expect(splitCalls).toHaveLength(1)
    const call = splitCalls[0]
    if (call?.method !== 'splitPane') throw new Error('expected splitPane')
    expect(call.opts.session).toBe('orch-scratch')
    expect(call.opts.socket).toBe(SCRATCH_SOCKET)
    expect(call.opts.argv).toEqual([
      'tail',
      '-n',
      '5000',
      '-F',
      `${tempDir}/agents/plan/formatted_output.ansi`,
    ])

    await controller.stop()
    await cleanup(tempDir)
  })

  it('spawns a pty hidden pane with argv, env, and cwd forwarded verbatim', async () => {
    const { tmux, controller, tempDir } = await makeController()

    tmux.nextPaneId(paneId('%200'))
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

    const splitCalls = tmux.recordedCalls.filter((c) => c.method === 'splitPane')
    expect(splitCalls).toHaveLength(1)
    const call = splitCalls[0]
    if (call?.method !== 'splitPane') throw new Error('expected splitPane')
    expect(call.opts.session).toBe('orch-scratch')
    expect(call.opts.argv).toEqual(['claude', '--prompt', 'help'])
    expect(call.opts.env).toEqual({ FORCE_COLOR: '3' })
    expect(call.opts.cwd).toBe(toPath(tempDir))

    await controller.stop()
    await cleanup(tempDir)
  })

  it('is idempotent when called twice with the same key', async () => {
    const { tmux, controller, tempDir } = await makeController()

    tmux.nextPaneId(paneId('%100'))
    const liveKey: SourceKey = { type: 'live', stepName: stepName('plan') }
    const spec = {
      kind: 'file-tail' as const,
      path: toPath(`${tempDir}/agents/plan/formatted_output.ansi`),
    }
    await controller.registerSource(liveKey, spec)
    await controller.registerSource(liveKey, spec)

    const splitCalls = tmux.recordedCalls.filter((c) => c.method === 'splitPane')
    expect(splitCalls).toHaveLength(1)

    await controller.stop()
    await cleanup(tempDir)
  })
})

describe('right-pane-controller pane-map: showSource', () => {
  it('issues swapPane(src=hidden, dst=visible) and updates the visible pane id', async () => {
    const { tmux, controller, tempDir } = await makeController()

    tmux.nextPaneId(paneId('%100'))
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
    tmux.nextPaneId(paneId('%200'))
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

  it('is a no-op when currentKey already equals the target key', async () => {
    const { tmux, controller, tempDir } = await makeController()

    tmux.nextPaneId(paneId('%100'))
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
  it('transforms a live key into a replay key without killing the hidden pane', async () => {
    const { tmux, controller, tempDir } = await makeController()

    tmux.nextPaneId(paneId('%100'))
    const liveKey: SourceKey = { type: 'live', stepName: stepName('plan') }
    await controller.registerSource(liveKey, {
      kind: 'file-tail',
      path: toPath(`${tempDir}/plan.ansi`),
    })

    await controller.unregisterSource(liveKey)

    const kills = tmux.recordedCalls.filter((c) => c.method === 'killPane')
    expect(kills).toHaveLength(0)

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

  it('kills the hidden pane for an interactive key (no warm cache)', async () => {
    const { tmux, controller, tempDir } = await makeController()

    tmux.nextPaneId(paneId('%200'))
    const key: SourceKey = { type: 'interactive', stepName: stepName('agent') }
    await controller.registerSource(key, {
      kind: 'pty',
      argv: ['claude'],
    })

    await controller.unregisterSource(key)

    const kills = tmux.recordedCalls.filter((c) => c.method === 'killPane')
    expect(kills).toHaveLength(1)
    const kill = kills[0]
    if (kill?.method !== 'killPane') throw new Error('expected killPane')
    expect(kill.opts.target).toBe(paneId('%200'))
    expect(kill.opts.socket).toBe(SCRATCH_SOCKET)

    await controller.stop()
    await cleanup(tempDir)
  })

  it('kills the hidden pane for a rollup key', async () => {
    const { tmux, controller, tempDir } = await makeController()

    tmux.nextPaneId(paneId('%300'))
    const key: SourceKey = { type: 'rollup' }
    await controller.registerSource(key, {
      kind: 'file-tail',
      path: toPath(`${tempDir}/_rollup.ansi`),
    })

    await controller.unregisterSource(key)

    const kills = tmux.recordedCalls.filter((c) => c.method === 'killPane')
    expect(kills).toHaveLength(1)

    await controller.stop()
    await cleanup(tempDir)
  })
})

describe('right-pane-controller pane-map: followLive', () => {
  it('prefers rollup over live sources when both are registered', async () => {
    const { tmux, controller, tempDir } = await makeController()

    tmux.nextPaneId(paneId('%100'))
    await controller.registerSource(
      { type: 'live', stepName: stepName('plan') },
      { kind: 'file-tail', path: toPath(`${tempDir}/plan.ansi`) },
    )
    tmux.nextPaneId(paneId('%200'))
    await controller.registerSource(
      { type: 'rollup' },
      { kind: 'file-tail', path: toPath(`${tempDir}/_rollup.ansi`) },
    )

    await controller.followLive()

    const swap = tmux.recordedCalls.find((c) => c.method === 'swapPane')
    if (swap?.method !== 'swapPane') throw new Error('expected swapPane')
    // Rollup hidden pane id is %200 — followLive picks rollup over live.
    expect(swap.opts.src).toBe(paneId('%200'))

    await controller.stop()
    await cleanup(tempDir)
  })

  it('picks the most-recently-registered live source when rollup is absent', async () => {
    const { tmux, controller, tempDir } = await makeController()

    tmux.nextPaneId(paneId('%100'))
    await controller.registerSource(
      { type: 'live', stepName: stepName('plan') },
      { kind: 'file-tail', path: toPath(`${tempDir}/plan.ansi`) },
    )
    tmux.nextPaneId(paneId('%200'))
    await controller.registerSource(
      { type: 'live', stepName: stepName('apply') },
      { kind: 'file-tail', path: toPath(`${tempDir}/apply.ansi`) },
    )

    await controller.followLive()

    const swap = tmux.recordedCalls.find((c) => c.method === 'swapPane')
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

describe('right-pane-controller pane-map: scratchSession guard', () => {
  it('throws a clear error if a pane-map method is called without scratchSession configured', async () => {
    const tmux = new FakeTmuxService()
    const queue = createPaneQueue()
    const tempDir = await mkdtemp('/tmp/orch-pane-map-guard-')
    const controller = createRightPaneController({
      tmux,
      socket: MAIN_SOCKET,
      leftPaneId: LEFT_PANE,
      rightPaneId: RIGHT_PANE,
      paneQueue: queue,
      stateStore: makeStore(),
      runId: RUN_ID,
      stateDir: toPath(tempDir),
      cwd: toPath(tempDir),
      env: {},
      stderr: bufferStream(),
      // scratchSession deliberately omitted.
    })

    const key: SourceKey = { type: 'live', stepName: stepName('plan') }
    await expect(
      controller.registerSource(key, {
        kind: 'file-tail',
        path: toPath(`${tempDir}/plan.ansi`),
      }),
    ).rejects.toThrow(/scratchSession not configured/)

    await controller.stop()
    await cleanup(tempDir)
  })
})
