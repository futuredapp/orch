// MIGRATED ← tests/unit/hosts/two-pane/pane-map/right-pane-controller-replay-dead-pane.test.ts (parent U7b)
//
// `model/controller` category (see ./README.md): plain class tests at the
// `FakeTmuxService` seam, no `scenario()`. A dead-pane DECISION — the controller
// must not swap to a pane whose per-source session was torn down. Asserted via
// the fake's pane-ownership table (`liveOwnedPanes`), so it passes with an empty
// pane: the risk is the decision, not the bytes.
//
// Reproducing coverage for Issue 3 — replay swaps to a torn-down pane:
//
//   replay failed for check-1-1 — TmuxCommandError:
//     tmux swap-pane failed (exit 1): can't find pane: %7
//
// The mechanism: a live step registers `live:<step>` (pane %5); on completion the
// live → replay transform rekeys it to `replay:<step>` and keeps pane %5 (warm
// cache); that per-source session is then torn down out-of-band (pane %5 gone);
// the user presses Enter on the completed step and `dispatchEnter` reuses the
// warm `replay:<step>` entry and swaps to dead %5. The fix must not swap to a
// `src` it can no longer prove is alive.

import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { StepName } from '../../../src/core/types.ts'
import {
  createRightPaneController,
  type SourceKey,
  sanitizeSessionName,
} from '../../../src/hosts/two-pane/pane-map/index.ts'
import { createPaneQueue } from '../../../src/hosts/two-pane/pane-queue.ts'
import { FakeTmuxService, paneId, socketName } from '../../../src/services/tmux/index.ts'
import { path as toPath } from '../../../src/services/types.ts'
import { type RunId, type StepEntry, runId as toRunId } from '../../../src/state/index.ts'
import { bufferStream, flush, liveOwnedPanes, makeStore } from './_support.ts'

const RUN_ID: RunId = toRunId('r-2026-05-11-100000-pm')
const RIGHT_PANE = paneId('%7')
const LEFT_PANE = paneId('%0')
const SOCKET = socketName('orch-main-test')
const LIVE_PANE = paneId('%5')

const stepName = (s: string): StepName => s as StepName

describe('right-pane-controller pane-map: replay after the source session was torn down', () => {
  it('does not swap-pane to the dead pane of a completed step whose per-source session was killed', async () => {
    // Arrange: a completed command step persisted in the run, plus the live
    // source it produced. The live pane is %5 in session orch-src-live-check-1-1.
    const tmux = new FakeTmuxService()
    const tempDir = await mkdtemp('/tmp/orch-replay-dead-pane-')
    const liveSession = sanitizeSessionName('live:check-1-1')
    const otherLiveSession = sanitizeSessionName('live:check-1-2')
    const steps: Record<string, StepEntry> = {
      'check-1-1': {
        name: 'check-1-1',
        kind: 'command',
        status: 'completed',
        startedAt: 1,
        finishedAt: 2,
      } as unknown as StepEntry,
    }
    await writeFile(`${tempDir}/check-1-1.ansi`, 'first check\n', 'utf8')
    await writeFile(`${tempDir}/check-1-2.ansi`, 'second check\n', 'utf8')
    const controller = createRightPaneController({
      tmux,
      socket: SOCKET,
      leftPaneId: LEFT_PANE,
      rightPaneId: RIGHT_PANE,
      paneQueue: createPaneQueue(),
      stateStore: makeStore(RUN_ID, steps),
      runId: RUN_ID,
      stateDir: toPath(tempDir),
      cwd: toPath(tempDir),
      env: {},
      stderr: bufferStream(),
      width: 200,
      height: 50,
    })

    const liveKey: SourceKey = { type: 'live', stepName: stepName('check-1-1') }
    tmux.nextCreateSessionPaneId(LIVE_PANE)
    await controller.registerSource(liveKey, {
      kind: 'file-tail',
      path: toPath(`${tempDir}/check-1-1.ansi`),
    })
    // Step completes: live → replay transform keeps pane %5 alive (warm cache).
    await controller.unregisterSource(liveKey)

    // Move the visible pane away from check-1-1 while the warm replay cache is
    // still valid. This mirrors the real UI: the user keeps navigating/running
    // other steps, then comes back to the old completed step later.
    const otherLiveKey: SourceKey = { type: 'live', stepName: stepName('check-1-2') }
    tmux.nextCreateSessionPaneId(paneId('%6'))
    await controller.registerSource(otherLiveKey, {
      kind: 'file-tail',
      path: toPath(`${tempDir}/check-1-2.ansi`),
    })
    await controller.showSource(otherLiveKey)

    // The per-source session backing replay:check-1-1 is torn down out-of-band;
    // pane %5 no longer exists. A later replay must not reuse it.
    await tmux.killSession({ socket: SOCKET, session: liveSession })
    const callsBeforeReplay = tmux.recordedCalls.length
    tmux.nextCreateSessionPaneId(paneId('%8'))

    // Act: the user revisits the completed step from the steps view.
    controller.onIntent({ type: 'enter', stepName: 'check-1-1' })
    await flush(12)

    // Assert: the replay action after the out-of-band teardown does not target
    // the dead cached pane. The replay path either re-registers a fresh pane
    // (whose createSession re-populates the ownership table) or refuses the
    // swap — either way, swaps caused by this replay must use live pane ids.
    const replaySession = sanitizeSessionName('replay:check-1-1')
    const placeholderSession = sanitizeSessionName('placeholder')
    const owned = liveOwnedPanes(tmux, SOCKET, [
      liveSession,
      otherLiveSession,
      replaySession,
      placeholderSession,
    ])

    const replaySwaps = tmux.recordedCalls
      .slice(callsBeforeReplay)
      .filter((c) => c.method === 'swapPane')
    expect(replaySwaps.length).toBeGreaterThan(0)
    for (const swap of replaySwaps) {
      if (swap.method !== 'swapPane') throw new Error('expected swapPane')
      expect(owned.has(String(swap.opts.src))).toBe(true)
      expect(String(swap.opts.src)).not.toBe(String(LIVE_PANE))
    }

    await controller.stop()
    await rm(tempDir, { recursive: true, force: true })
  })
})
