// MIGRATED ← tests/unit/hosts/two-pane/pane-map/right-pane-controller.test.ts (parent U7a)
//   — follow-live auto-advance / teardownSessions / followLive / concurrent
//   registerSource race. Split from the 700-line original (repo caps test files
//   at 600 lines); the registerSource/showSource/unregisterSource blocks live in
//   right-pane-controller-sources.test.ts.
//
// `model/controller` category (see ./README.md): plain class tests at the
// `FakeTmuxService` seam, no `scenario()`.

import { describe, expect, it } from 'bun:test'
import type { SourceKey } from '../../../src/hosts/two-pane/pane-map/index.ts'
import { paneId } from '../../../src/services/tmux/index.ts'
import { path as toPath } from '../../../src/services/types.ts'
import { cleanup, makeController, RIGHT_PANE, stepName } from './right-pane-controller-fixture.ts'

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
