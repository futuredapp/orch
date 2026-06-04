// Reproducing coverage for run r-2026-05-25-171216-nu — the post-completion
// crash that drew tmux's "can't find pane: %29" stack over the still-running
// TUI ("both the TUI and the CLI error were visible at once; I could still
// move the step cursor").
//
// The mechanism (confirmed against the controller, no mocks of internals):
//
//   1. After the run completes, the user presses Enter on a past *interactive*
//      agent step. `dispatchEnter` finds no live/interactive source in the map
//      and takes the replay path, which `replayKeyFor` maps back to an
//      `interactive:<step>` key (interactive steps resume as a pty). It
//      registers a fresh per-source session whose pane (here %29) runs the
//      resume command, and swaps it into the visible slot.
//   2. The user navigates away to another step. Pane %29 is swapped to the
//      hidden slot. The resume process inside it exits on its own (the agent
//      CLI quits / finishes) — tmux destroys pane %29 with it. Crucially, NO
//      `unregisterSource` runs for this revisit-registered interactive source,
//      so the `panes` map still holds `interactive:<step>` → dead pane %29.
//   3. The user presses Enter on that same step again. `dispatchEnter` hits the
//      `liveExists || interactiveExists` short-circuit (the stale entry is
//      still in the map), SKIPS the `invalidateSourceIfSessionGone` guard that
//      the replay branch performs, and issues `swapPane(src=%29, dst=<visible>)`
//      — a swap to a pane that no longer exists. Real tmux answers "can't find
//      pane: %29".
//
// `FakeTmuxService.swapPane` does NOT validate pane existence (it only throws
// when the whole socket is `markSocketLost`), so the bug is silent under the
// fake unless we assert the invariant explicitly. We assert it the same way
// the sibling `right-pane-controller-replay-dead-pane` test does: every
// `swapPane` the controller issues must reference a `src` pane still owned by a
// live session in the fake's pane-ownership table. The fake already models
// per-session pane ownership and clears it on `killSession`, so no fake change
// is needed — the seam (`*Service` edge) is the only thing stubbed.
//
// FAILS today: the short-circuit reuses the stale interactive entry and swaps
// to dead pane %29. PASSES once fixed: the short-circuit must validate the
// cached source's session is still alive before swapping (re-registering a
// fresh source when it is gone), mirroring the replay branch.

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
import type { SessionLogger } from '../../../../../src/observability/index.ts'
import { createNullSessionLogger } from '../../../../../src/observability/index.ts'
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

const RUN_ID: RunId = toRunId('r-2026-05-25-171216-nu')
const RIGHT_PANE = paneId('%6')
const LEFT_PANE = paneId('%0')
const SOCKET = socketName('orch-interactive-dead-pane')
const RESUME_PANE = paneId('%29')
const OTHER_LIVE_PANE = paneId('%26')
const FRESH_PANE = paneId('%30')

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
  } as unknown as StepEntry
}

function makeStore(steps: Record<string, StepEntry>): StateStore {
  const state: RunState = {
    schemaVersion: 5,
    id: RUN_ID,
    status: 'completed',
    workflowName: 'tic-tac-toe',
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
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 0))
  }
}

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

describe('right-pane-controller pane-map: revisiting an interactive step whose resume pane died out-of-band', () => {
  it('does not swap-pane to the dead resume pane of a cached interactive source', async () => {
    // Arrange: a completed interactive agent step persisted in the run, plus a
    // revisit-registered interactive resume source whose pane is %29.
    const tmux = new FakeTmuxService()
    const tempDir = await mkdtemp('/tmp/orch-interactive-dead-pane-')
    const interactiveSession = sanitizeSessionName('interactive:move-1-9-codex')
    const otherLiveSession = sanitizeSessionName('live:check-1-9')
    const steps: Record<string, StepEntry> = {
      'move-1-9-codex': makeStep({ name: 'move-1-9-codex', mode: 'interactive' }),
    }
    await writeFile(`${tempDir}/check.ansi`, 'check transcript\n', 'utf8')
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

    // The revisit-registered interactive resume source: pane %29 in session
    // orch-src-interactive-move-1-9-codex. (In production this is registered by
    // dispatchEnter's replay branch on the first post-run revisit.)
    const interactiveKey: SourceKey = {
      type: 'interactive',
      stepName: stepName('move-1-9-codex'),
    }
    tmux.nextCreateSessionPaneId(RESUME_PANE)
    await controller.registerSource(interactiveKey, {
      kind: 'file-tail',
      path: toPath(`${tempDir}/check.ansi`),
    })
    await controller.showSource(interactiveKey)

    // The user navigates away to another step, moving the visible slot off %29.
    const otherLiveKey: SourceKey = { type: 'live', stepName: stepName('check-1-9') }
    tmux.nextCreateSessionPaneId(OTHER_LIVE_PANE)
    await controller.registerSource(otherLiveKey, {
      kind: 'file-tail',
      path: toPath(`${tempDir}/check.ansi`),
    })
    await controller.showSource(otherLiveKey)

    // The resume process inside %29 exits on its own — tmux destroys its pane.
    // No unregisterSource runs, so the stale interactive entry survives in the
    // map. We model the dead-pane condition directly via the tmux edge.
    await tmux.killSession({ socket: SOCKET, session: interactiveSession })
    const callsBeforeRevisit = tmux.recordedCalls.length
    tmux.nextCreateSessionPaneId(FRESH_PANE)

    // Act: the user presses Enter on the interactive step again.
    controller.onIntent({ type: 'enter', stepName: 'move-1-9-codex' })
    await flush()

    // Assert: the revisit must not swap to the dead resume pane %29. The fix
    // re-registers a fresh source (whose createSession repopulates the
    // ownership table) before swapping — every swap must use a live pane id.
    const replaySession = sanitizeSessionName('replay:move-1-9-codex')
    const placeholderSession = sanitizeSessionName('placeholder')
    const owned = liveOwnedPanes(tmux, SOCKET, [
      interactiveSession,
      otherLiveSession,
      replaySession,
      placeholderSession,
    ])

    const revisitSwaps = tmux.recordedCalls
      .slice(callsBeforeRevisit)
      .filter((c) => c.method === 'swapPane')
    expect(revisitSwaps.length).toBeGreaterThan(0)
    for (const swap of revisitSwaps) {
      if (swap.method !== 'swapPane') throw new Error('expected swapPane')
      expect(String(swap.opts.src)).not.toBe(String(RESUME_PANE))
      expect(owned.has(String(swap.opts.src))).toBe(true)
    }

    await controller.stop()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('surfaces a swap failure as an error banner instead of letting it escape and bleed to the TTY', async () => {
    // The crash's user-visible symptom was a tmux error stack drawn over the
    // live TUI: dispatchEnter's live/interactive short-circuit is OUTSIDE its
    // try/catch, and onIntent fires it as `void dispatchEnter(...)`, so a swap
    // failure becomes an unhandled rejection that Node writes to fd-2 — the
    // TTY shared with the tmux client. A swap failure on this path must instead
    // be contained and surfaced as a user-facing error banner (the controller's
    // standing "never write to fd-2" contract), the same way the replay branch
    // already handles its failures.
    const captured = capturingLogger()
    const tmux = new FakeTmuxService()
    const tempDir = await mkdtemp('/tmp/orch-interactive-dead-pane-banner-')
    const controller = createRightPaneController({
      tmux,
      socket: SOCKET,
      leftPaneId: LEFT_PANE,
      rightPaneId: RIGHT_PANE,
      paneQueue: createPaneQueue(),
      stateStore: makeStore({
        'move-1-9-codex': makeStep({ name: 'move-1-9-codex', mode: 'interactive' }),
      }),
      runId: RUN_ID,
      stateDir: toPath(tempDir),
      cwd: toPath(tempDir),
      env: {},
      stderr: bufferStream(),
      width: 200,
      height: 50,
      logger: captured.logger,
    })

    await writeFile(`${tempDir}/resume.ansi`, 'resume transcript\n', 'utf8')
    const interactiveKey: SourceKey = {
      type: 'interactive',
      stepName: stepName('move-1-9-codex'),
    }
    tmux.nextCreateSessionPaneId(RESUME_PANE)
    await controller.registerSource(interactiveKey, {
      kind: 'file-tail',
      path: toPath(`${tempDir}/resume.ansi`),
    })
    await controller.showSource(interactiveKey)

    // The whole tmux server dies underneath the run — the canonical condition
    // that makes every subsequent swap throw (incident r-2026-05-22-093650-j0).
    tmux.markSocketLost(SOCKET)

    // Act: revisit the interactive step. The short-circuit's swap will fail.
    controller.onIntent({ type: 'enter', stepName: 'move-1-9-codex' })
    await flush()

    // Assert: the failure is contained as an error banner, not an escaped
    // rejection. Today the short-circuit throws past dispatchEnter's try/catch,
    // so no banner is emitted.
    const errorBanner = captured.entries
      .filter((e) => e.category === 'lifecycle')
      .map(
        (e) => e.record as { readonly type?: string; readonly banner?: { readonly kind?: string } },
      )
      .find((r) => r.type === 'banner-emit' && r.banner?.kind === 'error')
    expect(errorBanner).toBeDefined()

    await controller.stop()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('does not swap-pane to a dead source when the user presses follow-live (f)', async () => {
    // The same defect class in a second, not-yet-reported location. `followLive`
    // (the `f` key) walks the liveSources list and `showSource`s the chosen key
    // with NO liveness check and NO try/catch — and onIntent fires it as
    // `void followLive()`. A runner that died (its per-source session torn down)
    // leaves a stale entry in liveSources; pressing `f` swaps to its dead pane,
    // crashing exactly like the Enter path did. This confirms the missing
    // guard is a recurring pattern, not localized to dispatchEnter.
    const tmux = new FakeTmuxService()
    const tempDir = await mkdtemp('/tmp/orch-followlive-dead-pane-')
    const interactiveSession = sanitizeSessionName('interactive:move-1-9-codex')
    const placeholderSession = sanitizeSessionName('placeholder')
    await writeFile(`${tempDir}/resume.ansi`, 'resume transcript\n', 'utf8')
    const controller = createRightPaneController({
      tmux,
      socket: SOCKET,
      leftPaneId: LEFT_PANE,
      rightPaneId: RIGHT_PANE,
      paneQueue: createPaneQueue(),
      stateStore: makeStore({
        'move-1-9-codex': makeStep({ name: 'move-1-9-codex', mode: 'interactive' }),
      }),
      runId: RUN_ID,
      stateDir: toPath(tempDir),
      cwd: toPath(tempDir),
      env: {},
      stderr: bufferStream(),
      width: 200,
      height: 50,
    })

    // A live interactive source whose pane is %29; it lands in liveSources.
    const interactiveKey: SourceKey = {
      type: 'interactive',
      stepName: stepName('move-1-9-codex'),
    }
    tmux.nextCreateSessionPaneId(RESUME_PANE)
    await controller.registerSource(interactiveKey, {
      kind: 'file-tail',
      path: toPath(`${tempDir}/resume.ansi`),
    })
    await controller.showSource(interactiveKey)

    // Move the visible slot to a placeholder (not tracked in liveSources).
    tmux.nextCreateSessionPaneId(FRESH_PANE)
    await controller.registerSource({ type: 'placeholder' } satisfies SourceKey, {
      kind: 'file-tail',
      path: toPath('/dev/null'),
    })
    await controller.showSource({ type: 'placeholder' } satisfies SourceKey)

    // The interactive source's process exits; its session/pane is torn down.
    await tmux.killSession({ socket: SOCKET, session: interactiveSession })
    const callsBeforeFollow = tmux.recordedCalls.length

    // Act: the user presses `f` to follow live.
    controller.onIntent({ type: 'follow-live' })
    await flush()

    // Assert: follow-live must not swap to the dead interactive pane %29.
    const owned = liveOwnedPanes(tmux, SOCKET, [interactiveSession, placeholderSession])
    const followSwaps = tmux.recordedCalls
      .slice(callsBeforeFollow)
      .filter((c) => c.method === 'swapPane')
    for (const swap of followSwaps) {
      if (swap.method !== 'swapPane') throw new Error('expected swapPane')
      expect(String(swap.opts.src)).not.toBe(String(RESUME_PANE))
      expect(owned.has(String(swap.opts.src))).toBe(true)
    }

    await controller.stop()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('recovers by re-registering when the cached interactive pane died but its session is still alive (remain-on-exit)', async () => {
    // The real production condition: tmux runs with `remain-on-exit on`, so when
    // the interactive resume pty exits, its pane lingers dead inside a session
    // that `hasSession` still reports as ALIVE. The session-granular guard
    // cannot drop it, so the swap is attempted and tmux answers "can't find
    // pane". The controller must catch that, forget the stale source, and
    // re-register a fresh one — surfacing the step content, not a crash and not
    // an error banner. `move-1-9-codex` is a completed (persisted) step, so the
    // recovery now lives on the replay path (`replay-pane-stale-refresh`).
    const captured = capturingLogger()
    const tmux = new FakeTmuxService()
    const tempDir = await mkdtemp('/tmp/orch-remain-on-exit-')
    await writeFile(`${tempDir}/resume.ansi`, 'resume transcript\n', 'utf8')
    const controller = createRightPaneController({
      tmux,
      socket: SOCKET,
      leftPaneId: LEFT_PANE,
      rightPaneId: RIGHT_PANE,
      paneQueue: createPaneQueue(),
      stateStore: makeStore({
        'move-1-9-codex': makeStep({ name: 'move-1-9-codex', mode: 'interactive' }),
      }),
      runId: RUN_ID,
      stateDir: toPath(tempDir),
      cwd: toPath(tempDir),
      env: {},
      stderr: bufferStream(),
      width: 200,
      height: 50,
      logger: captured.logger,
    })

    const interactiveKey: SourceKey = {
      type: 'interactive',
      stepName: stepName('move-1-9-codex'),
    }
    tmux.nextCreateSessionPaneId(RESUME_PANE)
    await controller.registerSource(interactiveKey, {
      kind: 'file-tail',
      path: toPath(`${tempDir}/resume.ansi`),
    })
    await controller.showSource(interactiveKey)

    // Move the visible slot to a placeholder so the dead source is not current.
    tmux.nextCreateSessionPaneId(paneId('%40'))
    await controller.registerSource({ type: 'placeholder' } satisfies SourceKey, {
      kind: 'file-tail',
      path: toPath('/dev/null'),
    })
    await controller.showSource({ type: 'placeholder' } satisfies SourceKey)

    // The resume pty exits; remain-on-exit keeps the pane lingering and dead.
    // hasSession stays true, but any swap touching %29 throws "can't find pane".
    tmux.markPaneDead(RESUME_PANE)
    const createsBefore = tmux.recordedCalls.filter((c) => c.method === 'createSession').length

    // The fresh re-registration spawns a new session pane.
    tmux.nextCreateSessionPaneId(FRESH_PANE)

    // Act: the user presses Enter on the interactive step again.
    controller.onIntent({ type: 'enter', stepName: 'move-1-9-codex' })
    await flush()

    // The stale source was detected via the swap failure and refreshed.
    const refresh = captured.entries
      .filter((e) => e.category === 'lifecycle')
      .map((e) => e.record as { readonly type?: string })
      .find((r) => r.type === 'replay-pane-stale-refresh')
    expect(refresh).toBeDefined()

    // A fresh source was re-registered.
    const createsAfter = tmux.recordedCalls.filter((c) => c.method === 'createSession').length
    expect(createsAfter).toBeGreaterThan(createsBefore)

    // The final swap lands on the fresh, live pane — never left resting on %29.
    const swaps = tmux.recordedCalls.filter((c) => c.method === 'swapPane')
    const lastSwap = swaps.at(-1)
    if (lastSwap?.method !== 'swapPane') throw new Error('expected a swapPane')
    expect(String(lastSwap.opts.src)).toBe(String(FRESH_PANE))

    // The recovery is silent — no error banner bled to the user.
    const errorBanner = captured.entries
      .filter((e) => e.category === 'lifecycle')
      .map(
        (e) => e.record as { readonly type?: string; readonly banner?: { readonly kind?: string } },
      )
      .find((r) => r.type === 'banner-emit' && r.banner?.kind === 'error')
    expect(errorBanner).toBeUndefined()

    await controller.stop()
    await rm(tempDir, { recursive: true, force: true })
  })
})
