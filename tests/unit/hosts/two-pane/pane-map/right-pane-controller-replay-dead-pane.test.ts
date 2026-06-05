// MIGRATED → tests-new/model/controller/right-pane-controller-replay-dead-pane.test.ts (parent U7) — replaced by plain model/* category tests; kept skipped on disk (D2).
// Reproducing coverage for Issue 3 — replay swaps to a torn-down pane:
//
//   replay failed for check-1-1 — TmuxCommandError:
//     tmux swap-pane failed (exit 1): can't find pane: %7
//
// The mechanism (confirmed against the controller, no mocks of internals):
//
//   1. A live step registers a `live:<step>` source. Its hidden pane (here
//      `%5`) lives in the per-source session `orch-src-live-<step>` and is
//      swapped into the visible slot on registration.
//   2. The step completes. `unregisterSource(live)` runs the live → replay
//      transform: it rekeys the SAME entry from `live:<step>` to
//      `replay:<step>` and deliberately KEEPS the hidden pane alive (warm
//      cache). The `panes` map now holds `replay:<step>` → pane `%5`, session
//      `orch-src-live-<step>`.
//   3. That per-source session is then torn down out-of-band — its pane `%5`
//      no longer exists. (In production this is the source-session teardown /
//      tmux-server churn the issue's "locks" note points at; here we model
//      the dead-pane condition directly via the tmux edge's `killSession`,
//      which clears the fake's pane-ownership table for that session.)
//   4. The user presses Enter on the completed step. `dispatchEnter` finds
//      the warm-cached `replay:<step>` entry, SKIPS re-registration (no fresh
//      `createSession`), and issues `swapPane(src=%5, dst=<visible>)` — a swap
//      to a pane that no longer exists. Real tmux answers "can't find pane".
//
// `FakeTmuxService.swapPane` does NOT validate pane existence (it only throws
// when the whole socket is `markSocketLost`), so the bug is silent under the
// fake unless we assert the invariant explicitly. We do exactly that: every
// `swapPane` the controller issues must reference a `src` pane that is still
// owned by a live session in the fake's pane-ownership table
// (`paneIdsForSession`). The fake already models per-session pane ownership
// and clears it on `killSession`, so this assertion is load-bearing — no fake
// modification is needed, and the seam (`*Service` edge) is the only thing
// stubbed.
//
// FAILS today: the replay path reuses the stale `replay:<step>` entry and
// swaps to pane `%5`, whose session was killed — `%5` is in no session's
// ownership list, so the invariant assertion fails. This is the exact stale-
// pane id reaching `swapPane` that produces "can't find pane" in real tmux.
//
// PASSES once fixed: the controller must not swap to a torn-down pane. A fix
// invalidates the warm-cached replay entry when its backing session/pane is
// gone (so `dispatchEnter` re-registers a fresh source before swapping), or
// otherwise refuses to swap a `src` it can no longer prove is alive.

import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { Writable } from 'node:stream'
import type { StepName } from '../../../../../src/core/types.ts'
import {
  createRightPaneController,
  type SourceKey,
  sanitizeSessionName,
} from '../../../../../src/hosts/two-pane/pane-map/index.ts'
import { createPaneQueue } from '../../../../../src/hosts/two-pane/pane-queue.ts'
import {
  FakeTmuxService,
  paneId,
  type SocketName,
  socketName,
} from '../../../../../src/services/tmux/index.ts'
import { path as toPath } from '../../../../../src/services/types.ts'
import {
  type RunId,
  type RunState,
  type StateStore,
  type StepEntry,
  runId as toRunId,
} from '../../../../../src/state/index.ts'

const RUN_ID: RunId = toRunId('r-2026-05-11-100000-pm')
const RIGHT_PANE = paneId('%7')
const LEFT_PANE = paneId('%0')
const SOCKET = socketName('orch-main-test')
const LIVE_PANE = paneId('%5')
const OTHER_LIVE_PANE = paneId('%6')
const REPLAY_PANE = paneId('%8')

const stepName = (s: string): StepName => s as StepName

function bufferStream(): NodeJS.WritableStream {
  return new Writable({
    write(_c, _e, cb) {
      cb()
    },
  }) as unknown as NodeJS.WritableStream
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

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 0))
  }
}

/**
 * Pane ids the fake still reports as owned by a live session on `socket`.
 * A swap whose `src`/`dst` is not in this set targets a torn-down pane —
 * exactly the "can't find pane" condition real tmux raises.
 */
function liveOwnedPanes(
  tmux: FakeTmuxService,
  socket: SocketName,
  sessions: readonly string[],
): Set<string> {
  const owned = new Set<string>()
  for (const session of sessions) {
    for (const pane of tmux.paneIdsForSession(socket, session)) {
      owned.add(String(pane))
    }
  }
  return owned
}

describe.skip('right-pane-controller pane-map: replay after the source session was torn down', () => {
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
      stateStore: makeStore(steps),
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
    tmux.nextCreateSessionPaneId(OTHER_LIVE_PANE)
    await controller.registerSource(otherLiveKey, {
      kind: 'file-tail',
      path: toPath(`${tempDir}/check-1-2.ansi`),
    })
    await controller.showSource(otherLiveKey)

    // The per-source session backing replay:check-1-1 is torn down out-of-band;
    // pane %5 no longer exists. A later replay must not reuse it.
    await tmux.killSession({ socket: SOCKET, session: liveSession })
    const callsBeforeReplay = tmux.recordedCalls.length
    tmux.nextCreateSessionPaneId(REPLAY_PANE)

    // Act: the user revisits the completed step from the steps view.
    controller.onIntent({ type: 'enter', stepName: 'check-1-1' })
    await flush()

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
