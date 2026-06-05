// MIGRATED ← tests/unit/hosts/two-pane/pane-map/right-pane-controller-interactive-dead-pane.test.ts (parent U7b)
//
// `model/controller` category (see ./README.md): plain class tests at the
// `FakeTmuxService` seam, no `scenario()`. Dead-pane DECISIONS — the risk is
// "did the controller decide not to swap to a dead pane", asserted at the fake's
// ownership seam (passes with an empty pane), NOT a full-host rendering test.
//
// Reproducing coverage for run r-2026-05-25-171216-nu — the post-completion
// crash that drew tmux's "can't find pane: %29" stack over the still-running
// TUI. A revisit-registered interactive resume pane (%29) exits on its own; no
// `unregisterSource` runs, so a stale `interactive:<step>` entry survives. The
// next Enter short-circuits, skips the liveness guard, and swaps to dead %29.
// The fix must validate the cached source's session before swapping.

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
import { bufferStream, capturingLogger, flush, liveOwnedPanes, makeStep, makeStore } from './_support.ts'

const RUN_ID: RunId = toRunId('r-2026-05-25-171216-nu')
const RIGHT_PANE = paneId('%6')
const LEFT_PANE = paneId('%0')
const SOCKET = socketName('orch-interactive-dead-pane')
const RESUME_PANE = paneId('%29')
const OTHER_LIVE_PANE = paneId('%26')
const FRESH_PANE = paneId('%30')

const stepName = (s: string): StepName => s as StepName

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
      stateStore: makeStore(RUN_ID, steps, 'completed'),
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
    await flush(12)

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
    // be contained and surfaced as a user-facing error banner.
    const captured = capturingLogger(RUN_ID)
    const tmux = new FakeTmuxService()
    const tempDir = await mkdtemp('/tmp/orch-interactive-dead-pane-banner-')
    const controller = createRightPaneController({
      tmux,
      socket: SOCKET,
      leftPaneId: LEFT_PANE,
      rightPaneId: RIGHT_PANE,
      paneQueue: createPaneQueue(),
      stateStore: makeStore(
        RUN_ID,
        {
          'move-1-9-codex': makeStep({ name: 'move-1-9-codex', mode: 'interactive' }),
        },
        'completed',
      ),
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
    await flush(12)

    // Assert: the failure is contained as an error banner, not an escaped
    // rejection.
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
    // The same defect class in a second location. `followLive` (the `f` key)
    // walks the liveSources list and `showSource`s the chosen key with NO
    // liveness check and NO try/catch. A runner that died (its per-source
    // session torn down) leaves a stale entry; pressing `f` swaps to its dead
    // pane, crashing exactly like the Enter path did.
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
      stateStore: makeStore(
        RUN_ID,
        {
          'move-1-9-codex': makeStep({ name: 'move-1-9-codex', mode: 'interactive' }),
        },
        'completed',
      ),
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
    await flush(12)

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
    // that `hasSession` still reports as ALIVE. The session-granular guard cannot
    // drop it, so the swap is attempted and tmux answers "can't find pane". The
    // controller must catch that, forget the stale source, and re-register a
    // fresh one — surfacing the step content, not a crash and not an error banner.
    const captured = capturingLogger(RUN_ID)
    const tmux = new FakeTmuxService()
    const tempDir = await mkdtemp('/tmp/orch-remain-on-exit-')
    await writeFile(`${tempDir}/resume.ansi`, 'resume transcript\n', 'utf8')
    const controller = createRightPaneController({
      tmux,
      socket: SOCKET,
      leftPaneId: LEFT_PANE,
      rightPaneId: RIGHT_PANE,
      paneQueue: createPaneQueue(),
      stateStore: makeStore(
        RUN_ID,
        {
          'move-1-9-codex': makeStep({ name: 'move-1-9-codex', mode: 'interactive' }),
        },
        'completed',
      ),
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
    await flush(12)

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
