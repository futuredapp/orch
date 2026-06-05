// MIGRATED ← tests/unit/hosts/two-pane/pane-map/right-pane-controller.test.ts (parent U7a)
//   — registerSource / showSource / unregisterSource decisions. Split from the
//   700-line original (repo caps test files at 600 lines); the follow-live /
//   teardown / race describe blocks live in right-pane-controller-lifecycle.test.ts.
//
// `model/controller` category (see ./README.md): plain class tests at the
// `FakeTmuxService` seam, no `scenario()`. Each case asserts a controller
// DECISION (the recorded tmux calls), not pane bytes; the user-visible swap is
// covered by U6's full-host scenarios.

import { describe, expect, it } from 'bun:test'
import {
  type SourceKey,
  sanitizeSessionName,
} from '../../../src/hosts/two-pane/pane-map/index.ts'
import { paneId, TmuxCommandError } from '../../../src/services/tmux/index.ts'
import { path as toPath } from '../../../src/services/types.ts'
import { cleanup, makeController, RIGHT_PANE, SOCKET, stepName } from './right-pane-controller-fixture.ts'

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
