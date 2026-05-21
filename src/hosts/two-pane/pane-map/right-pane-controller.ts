// ---------------------------------------------------------------------------
// right-pane-controller (pane-map edition)
// ---------------------------------------------------------------------------
//
// Owns the `Map<SourceKey, PaneId>` that records which hidden pane in the
// per-run scratch session is currently rendering each source. Every change
// to the visible right pane is a `tmux swap-pane` issued by `showSource`;
// no caller directly respawns or sendKeys-blasts the visible slot.
//
// The public surface is four pane-map methods (`registerSource`, `showSource`,
// `unregisterSource`, `followLive`) plus `onIntent` for the steps-view
// keypress channel. The host wires `registerSource` / `unregisterSource` from
// `step:start` / `step:complete` lifecycle events; `onIntent('enter')`
// resolves a `PaneSpec` per step kind, registers the replay source (warm-
// cached on second view), and swaps it in.
//
// **Visible-slot invariant.** `swap-pane` exchanges processes between two
// pane positions, but pane ids stay attached to their original processes.
// So after every swap, the pane id rendering in the visible slot changes.
// The controller tracks the *current* visible pane id (`#visiblePaneId`)
// and updates it after every swap; future swaps target the up-to-date
// destination.

import { appendFile, mkdir, stat, writeFile } from 'node:fs/promises'
import type { StepName } from '../../../core/types.ts'
import { orchLog, type SessionLogger } from '../../../observability/index.ts'
import type { Runner } from '../../../runners/index.ts'
import {
  type PaneId,
  type SocketName,
  TmuxCommandError,
  type TmuxService,
} from '../../../services/tmux/index.ts'
import { type Path, path as toPath } from '../../../services/types.ts'
import type { RunId, StateStore, StepEntry } from '../../../state/index.ts'
import { renderKindDetails } from '../kind-details.tsx'
import type { PaneQueue } from '../pane-queue.ts'
import { resolveCommandPaneSource } from '../replay-command-pane.ts'
import { renderTranscriptToString } from '../replay-transcript.ts'
import {
  type Banner,
  projectStepsView,
  type StepRow,
  type StepsIntent,
  serializeTuiOverlayLine,
  type TuiOverlay,
  type ViewMode,
} from '../steps-view/index.ts'
import { type PaneSpec, type SourceKey, sourceKeyToString } from './pane-spec.ts'
import type { ScratchSessionHandle } from './scratch-session.ts'

// Bound the first-view backfill when a hidden pane is swapped in for the
// first time. `-F` (capital) retries on inode changes so a tee reopen
// mid-run does not break the follow.
const TAIL_BACKFILL_LINES = '5000'

export interface RightPaneControllerOptions {
  readonly tmux: TmuxService
  readonly socket: SocketName
  readonly leftPaneId: PaneId
  readonly rightPaneId: PaneId
  readonly paneQueue: PaneQueue
  readonly stateStore: StateStore
  readonly runId: RunId
  readonly stateDir: Path
  readonly cwd: Path
  readonly env: Readonly<Record<string, string>>
  readonly stderr: NodeJS.WritableStream
  readonly logger?: SessionLogger
  /**
   * Handle to the per-run scratch session that hosts hidden panes. Required
   * for every pane-map operation (`registerSource` / `showSource` /
   * `unregisterSource` / `followLive`) and for `onIntent('enter')`, which
   * registers a replay source on enter. Kept optional in the type so unit
   * tests that only exercise the banner / view-mode plumbing can omit it,
   * but any method that needs a hidden pane will throw with a clear error
   * when it's not configured.
   */
  readonly scratchSession?: ScratchSessionHandle
  /**
   * Renderer for autonomous-agent transcripts. The CLI defaults this to
   * Claude's `toClaudeTranscriptLines`. Without it, replay falls back to a
   * JSON stringify which is unreadable.
   */
  readonly transcriptRenderer?: Runner['toTranscriptLines']
  /**
   * Live runner registry held by reference. The controller calls
   * `resumeRegistry.getRunnerForStep(step.name)` on every Enter press;
   * resolution is step-keyed (not runner-name-keyed) so two distinct
   * `claude({...})` instances with different model configs each resolve to
   * their own runner. Populated by the workflow executor's `runStepOnce`
   * during normal runs and progressively during `orch resume` replay.
   *
   * When omitted, Enter on any past interactive step falls back to a
   * `file-tail` over a "no runner wired into this host" refusal-text file.
   */
  readonly resumeRegistry?: import('../../../core/resume-registry.ts').ResumeRegistry
  /**
   * Absolute path to the parent → child IPC channel for banner + view-mode
   * snapshots. The controller appends one JSON line per `emitBanner` /
   * `setViewMode` / banner-clear; the steps-view model in the child tails
   * this file and re-projects.
   *
   * Optional so unit tests that don't assert on the IPC stream can omit it.
   * When omitted, `emitBanner` / `setViewMode` still update in-memory state
   * but the IPC write is silently skipped.
   */
  readonly tuiOverlayPath?: Path
}

const errorLifecycleFields = (err: unknown): Readonly<Record<string, unknown>> => {
  const base: Record<string, unknown> = {
    error: String(err),
  }
  if (err instanceof Error) {
    base.errorName = err.name
    base.errorMessage = err.message
  }
  if (err instanceof TmuxCommandError) {
    base.tmuxExitCode = err.exitCode
    base.tmuxStderr = err.stderr
  }
  return base
}

export interface RightPaneController {
  /** Wire this into `startStepsView`'s `onIntent`. */
  onIntent(intent: StepsIntent): void
  /**
   * Register a new source. Spawns a hidden pane in the scratch session;
   * stores the pane id under the source key. Idempotent — calling with the
   * same key is a no-op.
   *
   */
  registerSource(key: SourceKey, spec: PaneSpec): Promise<void>
  /**
   * Swap the visible right pane to the hidden pane that's rendering `key`.
   * No-op if `currentKey === key` or `key` is not in the map.
   */
  showSource(key: SourceKey): Promise<void>
  /**
   * Remove a source from the map. The rule is type-specific:
   *   - `live`: rekeyed to `replay` (warm cache, no kill).
   *   - `interactive`/`rollup`/`placeholder`: kill the hidden pane.
   */
  unregisterSource(key: SourceKey): Promise<void>
  /**
   * Swap to the most-recently-registered live or interactive source, or to
   * rollup if registered, or to placeholder if neither exists.
   */
  followLive(): Promise<void>
  /**
   * Look up the hidden-pane id for a registered source. Returns `undefined`
   * when the source is not in the map.
   *
   * Used by U6's interactive path: `runInteractive` registers a `pty`
   * source, then waits on `pane-exit-<hiddenPaneId>` to detect the runner's
   * exit. The hidden pane id is needed before `unregisterSource` runs
   * (which kills it), so the host queries the controller right after
   * register.
   */
  getPaneId(key: SourceKey): PaneId | undefined
  /**
   * Emit a banner. Bumps the controller's monotonic `bannerSeq` and writes a
   * snapshot to the TUI overlay IPC channel so the child renderer can
   * surface it. Caller passes `kind` + `text` + optional `ttlMs`; `seq` is
   * controller-assigned.
   *
   */
  emitBanner(input: Omit<Banner, 'seq'>): Promise<void>
  /**
   * Set the persistent footer indicator. Writes a snapshot to the TUI
   * overlay IPC channel. Independent of `banner` — both can change in the
   * same projection cycle.
   *
   */
  setViewMode(view: ViewMode): Promise<void>
  /** Tear down: drop references, stop accepting intents. */
  stop(): Promise<void>
}

export function createRightPaneController(opts: RightPaneControllerOptions): RightPaneController {
  let stopped = false

  // ---------------------------------------------------------------------------
  // New pane-map state (used by registerSource/showSource/...).
  // ---------------------------------------------------------------------------

  /** The pane id currently rendering in the visible slot. Updated after every
   *  successful swap. Initially the visible right pane the host created. */
  let visiblePaneId: PaneId = opts.rightPaneId
  /** Currently active source key. Undefined when nothing has been swapped in. */
  let currentKey: SourceKey | undefined
  /** The map. Keyed on `sourceKeyToString(key)` so structural equality works. */
  const panes = new Map<string, PaneId>()
  /** Insertion order of `live` / `interactive` keys, for `followLive()`. */
  const liveSources: string[] = []
  /** Map back from string key to its original SourceKey, for replay-key
   *  reconstruction during the `live → replay` transform. */
  const keyByString = new Map<string, SourceKey>()
  /**
   * In-flight `registerSource` promises keyed by `sourceKeyToString(key)`.
   * Lifecycle handlers wire `registerSource` / `unregisterSource` as
   * fire-and-forget (`void controller.X(...)`), so an `unregister` for a
   * source whose `register` is still awaiting `splitPane` would read
   * `panes.get(skey) === undefined` and bail out — leaving
   * `transformLiveToReplay` (and the `setViewMode({mode:'replay'})` that
   * follows) un-run. The next `step:start` then sees `currentView.mode ===
   * 'live'` and auto-swaps the new live source in, even though the user is
   * actually on a frozen replay. Tracking pending registrations and awaiting
   * them at the head of `unregisterSource` / `dispatchEnter` closes the race.
   */
  const pendingRegistrations = new Map<string, Promise<void>>()

  // ---------------------------------------------------------------------------
  // TUI overlay state: persistent view-mode + transient banner.
  // The monotonic `bannerSeq` counter — bumped on every `emitBanner` — is
  // load-bearing: the renderer's auto-dismiss timer keys on it so identical-
  // text emits restart the countdown instead of being deduped by React's
  // effect-dep diff.
  // ---------------------------------------------------------------------------

  let currentView: ViewMode = { mode: 'live' }
  let currentBanner: Banner | undefined
  let bannerSeq = 0

  const logLifecycle = (record: Readonly<Record<string, unknown>>): void => {
    void opts.logger?.append('lifecycle', record).catch(() => {})
  }

  const writeTuiOverlay = async (): Promise<void> => {
    if (opts.tuiOverlayPath === undefined) return
    const snapshot: TuiOverlay =
      currentBanner !== undefined
        ? { view: currentView, banner: currentBanner }
        : { view: currentView }
    try {
      await appendFile(opts.tuiOverlayPath, serializeTuiOverlayLine(snapshot), 'utf8')
    } catch (err) {
      opts.stderr.write(`[orch tui] tui-overlay write failed: ${String(err)}\n`)
    }
  }

  const emitBanner = async (input: Omit<Banner, 'seq'>): Promise<void> => {
    if (stopped) return
    bannerSeq += 1
    const next: Banner = {
      kind: input.kind,
      text: input.text,
      seq: bannerSeq,
      ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
    }
    currentBanner = next
    logLifecycle({ type: 'banner-emit', banner: next })
    await writeTuiOverlay()
  }

  const setViewMode = async (view: ViewMode): Promise<void> => {
    if (stopped) return
    currentView = view
    logLifecycle({ type: 'view-mode-changed', view })
    await writeTuiOverlay()
  }

  const dismissBanner = async (): Promise<void> => {
    if (stopped) return
    if (currentBanner === undefined) return
    currentBanner = undefined
    logLifecycle({ type: 'banner-dismissed' })
    await writeTuiOverlay()
  }

  // ---------------------------------------------------------------------------
  // Pane-map operations — every right-pane state change funnels through here.
  // ---------------------------------------------------------------------------

  const requireScratchSession = (): ScratchSessionHandle => {
    if (opts.scratchSession === undefined) {
      throw new Error(
        'right-pane-controller: scratchSession not configured (pane-map methods require it)',
      )
    }
    return opts.scratchSession
  }

  const spawnHiddenPane = async (spec: PaneSpec): Promise<PaneId> => {
    const scratch = requireScratchSession()
    if (spec.kind === 'file-tail') {
      return opts.tmux.splitPane({
        socket: scratch.socket,
        session: scratch.session,
        orientation: 'h',
        percent: 50,
        argv: ['tail', '-n', TAIL_BACKFILL_LINES, '-F', spec.path],
      })
    }
    return opts.tmux.splitPane({
      socket: scratch.socket,
      session: scratch.session,
      orientation: 'h',
      percent: 50,
      argv: spec.argv,
      ...(spec.env !== undefined ? { env: spec.env } : {}),
      ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
    })
  }

  const registerSource = async (key: SourceKey, spec: PaneSpec): Promise<void> => {
    if (stopped) return
    const skey = sourceKeyToString(key)
    const inFlight = pendingRegistrations.get(skey)
    if (inFlight !== undefined) {
      logLifecycle({ type: 'pane-spawn-pending', sourceKey: skey })
      await inFlight
      return
    }
    if (panes.has(skey)) {
      logLifecycle({ type: 'pane-spawn-skip-existing', sourceKey: skey })
      return
    }
    const work = (async (): Promise<void> => {
      const scratch = requireScratchSession()
      logLifecycle({
        type: 'pane-spawn-start',
        sourceKey: skey,
        specKind: spec.kind,
        socket: scratch.socket,
        session: scratch.session,
      })
      let paneId: PaneId
      try {
        paneId = await spawnHiddenPane(spec)
      } catch (err) {
        logLifecycle({
          type: 'pane-spawn-failed',
          sourceKey: skey,
          specKind: spec.kind,
          socket: scratch.socket,
          session: scratch.session,
          ...errorLifecycleFields(err),
        })
        throw err
      }
      panes.set(skey, paneId)
      keyByString.set(skey, key)
      if (key.type === 'live' || key.type === 'interactive') {
        liveSources.push(skey)
      }
      logLifecycle({ type: 'pane-spawned', sourceKey: skey, paneId })
      // U5/U7: auto-swap-or-banner for live + rollup sources. If the user is
      // on live mode, swap the new source in (most-recent-live wins; rollup
      // takes the visible slot on registration just like a fresh live source).
      // If the user is on replay, leave them there but surface a transient
      // info banner so they know the new source is available behind `f`.
      if (key.type === 'live' || key.type === 'rollup') {
        if (currentView.mode === 'live') {
          await showSource(key)
        } else {
          const text =
            key.type === 'live'
              ? `step ${key.stepName} running — press f to follow`
              : `parallel branches running — press f to follow`
          await emitBanner({ kind: 'info', text, ttlMs: 4000 })
        }
      }
    })()
    // The stored promise is used by `unregisterSource`/`dispatchEnter` to
    // drain in-flight registrations. Swallow rejections on the stored chain
    // (callers attach their own `.catch`) so a failed `registerSource` does
    // not surface as an unhandled rejection on the `.finally` continuation —
    // the original rejection is still observed via `await work` below.
    const recorded = work
      .finally(() => {
        pendingRegistrations.delete(skey)
      })
      .catch(() => {})
    pendingRegistrations.set(skey, recorded)
    await work
  }

  const showSource = async (key: SourceKey): Promise<void> => {
    if (stopped) return
    const skey = sourceKeyToString(key)
    const hidden = panes.get(skey)
    if (hidden === undefined) {
      logLifecycle({ type: 'right-pane-swap-miss', sourceKey: skey })
      return
    }
    if (currentKey !== undefined && sourceKeyToString(currentKey) === skey) return
    // Sequential single-pane enqueue: visible-pane settles first (no work),
    // then hidden-pane carries the swap. Both calls share the global pane
    // queue so any pending writes to either pane finish before the swap.
    const dst = visiblePaneId
    logLifecycle({
      type: 'right-pane-swap-start',
      to: skey,
      srcPaneId: hidden,
      dstPaneId: dst,
    })
    try {
      await opts.paneQueue.enqueue(dst, () => Promise.resolve())
      await opts.paneQueue.enqueue(hidden, () =>
        opts.tmux.swapPane({ socket: opts.socket, src: hidden, dst }),
      )
    } catch (err) {
      logLifecycle({
        type: 'right-pane-swap-failed',
        to: skey,
        srcPaneId: hidden,
        dstPaneId: dst,
        ...errorLifecycleFields(err),
      })
      throw err
    }
    // After the swap: the hidden pane id now occupies the visible slot, and
    // the previously-visible pane id has moved to the hidden slot. We track
    // which pane id is visible so subsequent swaps target it.
    visiblePaneId = hidden
    currentKey = key
    logLifecycle({ type: 'right-pane-swap', to: skey, paneId: hidden })
  }

  const removeFromLiveSources = (skey: string): void => {
    const idx = liveSources.indexOf(skey)
    if (idx >= 0) liveSources.splice(idx, 1)
  }

  const transformLiveToReplay = (
    liveKey: SourceKey & { readonly type: 'live' },
    skey: string,
    hidden: PaneId,
  ): void => {
    const replayKey: SourceKey = { type: 'replay', stepName: liveKey.stepName }
    const replaySkey = sourceKeyToString(replayKey)
    panes.delete(skey)
    panes.set(replaySkey, hidden)
    keyByString.delete(skey)
    keyByString.set(replaySkey, replayKey)
    removeFromLiveSources(skey)
    if (currentKey !== undefined && sourceKeyToString(currentKey) === skey) {
      currentKey = replayKey
    }
    logLifecycle({ type: 'live-to-replay-transform', from: skey, to: replaySkey })
  }

  // Lazily register the always-blank placeholder hidden pane. Used by
  // killHiddenSource to keep the visible slot alive when the soon-to-be-
  // killed pane is the current visible source. Tails /dev/null so it
  // produces no bytes. Idempotent — second call is a no-op.
  const ensurePlaceholderRegistered = async (): Promise<void> => {
    const placeholderKey: SourceKey = { type: 'placeholder' }
    const skey = sourceKeyToString(placeholderKey)
    if (panes.has(skey)) return
    if (opts.scratchSession === undefined) return
    const paneId = await spawnHiddenPane({ kind: 'file-tail', path: toPath('/dev/null') })
    panes.set(skey, paneId)
    keyByString.set(skey, placeholderKey)
    logLifecycle({ type: 'pane-spawned', sourceKey: skey, paneId })
  }

  const killHiddenSource = async (skey: string, hidden: PaneId): Promise<void> => {
    if (currentKey !== undefined && sourceKeyToString(currentKey) === skey) {
      // The pane we are about to kill is currently in the visible slot
      // (due to a prior swap). Killing it without first relocating the
      // visible slot collapses the right pane and orphans visiblePaneId
      // at a dead pane id — every subsequent swapPane then fails with
      // `can't find pane: <hidden>`. Ensure a placeholder hidden pane
      // exists, swap to it, then proceed with the kill (which now lands
      // on the hidden slot, not the visible one).
      logLifecycle({ type: 'visible-pane-relocation-start', from: skey, paneId: hidden })
      await ensurePlaceholderRegistered()
      const placeholderKey: SourceKey = { type: 'placeholder' }
      if (panes.has(sourceKeyToString(placeholderKey))) await showSource(placeholderKey)
      logLifecycle({ type: 'visible-pane-relocation-complete', from: skey, paneId: hidden })
    }
    panes.delete(skey)
    keyByString.delete(skey)
    removeFromLiveSources(skey)
    logLifecycle({ type: 'pane-kill-start', sourceKey: skey, paneId: hidden })
    let killed = false
    try {
      await opts.tmux.killPane({ socket: requireScratchSession().socket, target: hidden })
      killed = true
    } catch (err) {
      logLifecycle({
        type: 'pane-kill-failed',
        sourceKey: skey,
        paneId: hidden,
        ...errorLifecycleFields(err),
      })
      opts.stderr.write(`[orch tui] killPane failed for ${skey}: ${String(err)}\n`)
    }
    logLifecycle({ type: 'pane-killed', sourceKey: skey, paneId: hidden, killed })
  }

  const unregisterSource = async (key: SourceKey): Promise<void> => {
    if (stopped) return
    const skey = sourceKeyToString(key)
    logLifecycle({ type: 'source-unregister-start', sourceKey: skey })
    // Drain any in-flight registration for this key first. Without this,
    // a fire-and-forget `unregister` queued behind a still-pending `register`
    // (its `splitPane` hasn't resolved) sees `panes.get(skey) === undefined`
    // and bails out — leaving the live→replay transform un-run and
    // `currentView` stuck on `live` for the next registration to swap into.
    const inFlight = pendingRegistrations.get(skey)
    if (inFlight !== undefined) {
      await inFlight.catch(() => {})
    }
    const hidden = panes.get(skey)
    if (hidden === undefined) {
      logLifecycle({ type: 'source-unregister-miss', sourceKey: skey })
      return
    }
    if (key.type === 'live') {
      logLifecycle({ type: 'source-unregister-live-to-replay', sourceKey: skey, paneId: hidden })
      // Transform: rekey the same hidden pane under the replay key. No kill.
      // The pane continues to tail the (now-frozen) tee; subsequent revisits
      // are O(1).
      const wasCurrent = currentKey !== undefined && sourceKeyToString(currentKey) === skey
      transformLiveToReplay(key, skey, hidden)
      // U5: if the user was watching this live source, surface the frozen-
      // transcript cue — info banner + view-mode flip. The host emits the
      // unconditional error banner separately on `step:failed`; that
      // overwrites this info banner via last-write-wins.
      if (wasCurrent) {
        await setViewMode({ mode: 'replay', stepName: key.stepName })
        await emitBanner({
          kind: 'info',
          text: `step ${key.stepName} complete`,
          ttlMs: 4000,
        })
      }
      return
    }
    // Interactive / rollup / placeholder / replay: kill the hidden pane and
    // drop the entry. If the current key is this one, swap to placeholder
    // FIRST so the visible slot doesn't reference a dead pane.
    logLifecycle({ type: 'source-unregister-kill', sourceKey: skey, paneId: hidden })
    await killHiddenSource(skey, hidden)
  }

  const followLive = async (): Promise<void> => {
    if (stopped) return
    const rollupKey: SourceKey = { type: 'rollup' }
    if (panes.has(sourceKeyToString(rollupKey))) {
      await showSource(rollupKey)
      return
    }
    // Walk newest-first and prefer a truly-live source. dispatchEnter on a
    // past interactive step re-registers `interactive:<step>` (an interactive
    // *replay* pane), and registerSource pushes both `live` and `interactive`
    // keys onto liveSources. Without this preference, `f` after entering a
    // past interactive step short-circuits — the replay key is both the
    // visible source and `liveSources.at(-1)`, so showSource returns early.
    for (let i = liveSources.length - 1; i >= 0; i--) {
      const skey = liveSources[i]
      if (skey === undefined) continue
      const key = keyByString.get(skey)
      if (key !== undefined && key.type === 'live') {
        await showSource(key)
        return
      }
    }
    // No truly-live source. Fall back to most-recent-anything so workflows
    // with only interactive steps still respond to `f`.
    const lastLive = liveSources.at(-1)
    if (lastLive !== undefined) {
      const key = keyByString.get(lastLive)
      if (key !== undefined) {
        await showSource(key)
        return
      }
    }
    const placeholderKey: SourceKey = { type: 'placeholder' }
    if (panes.has(sourceKeyToString(placeholderKey))) await showSource(placeholderKey)
  }

  // ---------------------------------------------------------------------------
  // onIntent — swap-based replay path (U8).
  //
  // Enter on a past step resolves a `PaneSpec` for that step's replay source,
  // registers it in the scratch session (or reuses a warm-cached entry), then
  // swaps the visible right pane to it. The legacy `respawnPane`-on-right-pane
  // path is gone — every right-pane state change now funnels through
  // `controller.showSource(...)`.
  // ---------------------------------------------------------------------------

  const lookupStep = async (stepName: string): Promise<StepRow | undefined> => {
    const run = await opts.stateStore.loadRun(opts.runId)
    const entry: StepEntry | undefined = run?.steps[stepName]
    const projected = projectStepsView({
      run,
      overlay: new Map(),
      workflowName: '',
      runIdFallback: opts.runId,
    })
    const fromProjection = projected.steps.find((s) => s.name === stepName)
    if (fromProjection !== undefined) return fromProjection
    if (entry === undefined) return undefined
    return undefined
  }

  const replayKeyFor = (step: StepRow): SourceKey => {
    if (step.kind === 'agent' && step.mode === 'interactive') {
      return { type: 'interactive', stepName: step.name as StepName }
    }
    return { type: 'replay', stepName: step.name as StepName }
  }

  const dispatchEnter = async (stepName: string): Promise<void> => {
    if (stopped) return

    // If the step is currently running, a `live:<step>` or `interactive:<step>`
    // source is already registered. Tune in to it instead of routing through
    // the replay path (which `lookupStep` can't satisfy for an in-flight step
    // with no persisted entry). Without this, Enter on the running row from
    // the step list silently logs `replay-lookup-miss` and the right pane
    // stays on the previous replay — the running step becomes unreachable.
    const liveKey: SourceKey = { type: 'live', stepName: stepName as StepName }
    const interactiveKey: SourceKey = { type: 'interactive', stepName: stepName as StepName }
    const liveExists = panes.has(sourceKeyToString(liveKey))
    const interactiveExists = panes.has(sourceKeyToString(interactiveKey))
    if (liveExists || interactiveExists) {
      const key = liveExists ? liveKey : interactiveKey
      await showSource(key)
      await setViewMode({ mode: 'live' })
      logLifecycle({
        type: 'live-pane-opened',
        stepName,
        sourceKey: sourceKeyToString(key),
      })
      return
    }

    const step = await lookupStep(stepName)
    if (step === undefined) {
      logLifecycle({ type: 'replay-lookup-miss', stepName })
      return
    }
    // Cached steps never produced a transcript; surface that as a transient
    // info banner rather than swapping to an empty replay pane.
    if (step.status === 'cached') {
      logLifecycle({ type: 'replay-cached-skip', stepName })
      await emitBanner({
        kind: 'info',
        text: `step ${stepName} — cached (no transcript captured)`,
        ttlMs: 4000,
      })
      return
    }

    const replayKey = replayKeyFor(step)
    try {
      const replaySkey = sourceKeyToString(replayKey)
      // If a registration for this replay key is mid-flight (the user pressed
      // Enter twice in quick succession), wait for it to finish before
      // deciding whether to spawn another pane. Without this drain, the
      // second call sees `panes.has(skey) === false` and `registerSource`
      // would split a duplicate pane (warm-cache invariant violation).
      const pending = pendingRegistrations.get(replaySkey)
      if (pending !== undefined) {
        await pending.catch(() => {})
      }
      if (!panes.has(replaySkey)) {
        const spec = await resolveReplaySpec(opts, step)
        await registerSource(replayKey, spec)
      }
      await showSource(replayKey)
      await setViewMode({ mode: 'replay', stepName: step.name })
      logLifecycle({
        type: 'replay-pane-opened',
        stepName,
        sourceKey: sourceKeyToString(replayKey),
      })
      orchLog(opts.logger, 'replay-kind-dispatched', { stepName, kind: step.kind })
    } catch (err) {
      opts.stderr.write(`[orch tui] replay dispatch failed: ${String(err)}\n`)
      logLifecycle({ type: 'replay-pane-failed', stepName, error: String(err) })
      await emitBanner({
        kind: 'error',
        text: `replay failed for ${stepName} — ${String(err)}`,
      })
    }
  }

  const onIntent = (intent: StepsIntent): void => {
    if (stopped) return
    logLifecycle({ type: 'replay-intent', intent })
    if (intent.type === 'enter') {
      void dispatchEnter(intent.stepName)
      return
    }
    if (intent.type === 'follow-live') {
      void followLive()
      return
    }
    if (intent.type === 'quit') {
      // Quit is owned by the CLI race (executeWithAttach) — the host's
      // tagged shutdown deferred fires on this intent and the CLI tears
      // orch down. The controller has nothing to do here; the previous
      // `followLive()` call was a no-op race against teardown that just
      // queued tmux commands which the killing session would discard.
      return
    }
    if (intent.type === 'dismiss-banner') {
      void dismissBanner()
    }
  }

  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
  }

  const getPaneId = (key: SourceKey): PaneId | undefined => {
    return panes.get(sourceKeyToString(key))
  }

  return {
    onIntent,
    registerSource,
    showSource,
    unregisterSource,
    followLive,
    getPaneId,
    emitBanner,
    setViewMode,
    stop,
  }
}

// ---------------------------------------------------------------------------
// resolveReplaySpec — per-kind PaneSpec resolution for `onIntent('enter')`.
//
// The contract:
//   - agent/autonomous → prefer the persisted ANSI tee
//     (`<logsDir>/agents/<stepName>/formatted_output.ansi`); fall back to a
//     JSON-NDJSON re-render written into `.replay/<safe>.txt` when the tee
//     is missing or empty (e.g. cancelled mid-run, or a fixture that never
//     opened the tee).
//   - agent/interactive → call the runner's `resumeCommand(...)` and spawn
//     it as a `pty` source so arrow keys / Ctrl-C / resize work natively.
//     A missing runner / missing `sessionId` / runner-without-resume falls
//     back to a `file-tail` over a refusal text written to `.replay/`.
//   - command → tail the captured pane log directly when it exists,
//     otherwise tail a placeholder text file (`.replay/<safe>.txt`).
//   - commit / worktree / ask → render `kind-details` into `.replay/<safe>.txt`
//     and tail it. `tail -F` of a static file backfills the bytes then idles.
// ---------------------------------------------------------------------------

async function resolveReplaySpec(
  opts: RightPaneControllerOptions,
  step: StepRow,
): Promise<PaneSpec> {
  if (step.kind === 'agent') {
    if (step.mode === 'interactive') {
      return resolveInteractiveReplaySpec(opts, step)
    }
    return resolveAutonomousReplaySpec(opts, step)
  }
  if (step.kind === 'command') {
    const paneLogPath = toPath(`${opts.stateDir}/logs/tmux/${opts.rightPaneId}.log`)
    const source = await resolveCommandPaneSource({ stepName: step.name, paneLogPath })
    if (source.kind === 'file') {
      return { kind: 'file-tail', path: source.path }
    }
    const filePath = replayFilePath(opts, step.name)
    await writeReplayFile(opts, filePath, source.text)
    return { kind: 'file-tail', path: filePath }
  }
  // commit / worktree / ask
  const payload = renderKindDetails({ step })
  const filePath = replayFilePath(opts, step.name)
  await writeReplayFile(opts, filePath, payload)
  return { kind: 'file-tail', path: filePath }
}

async function resolveAutonomousReplaySpec(
  opts: RightPaneControllerOptions,
  step: StepRow & { kind: 'agent'; mode: 'autonomous' },
): Promise<PaneSpec> {
  // Primary: the live tee that U5 wired now sits frozen on disk. Tailing it
  // directly preserves byte-fidelity (ANSI colors + control sequences) so a
  // post-mortem replay reads exactly like the live transcript.
  const teePath = autonomousTeePath(opts.logger, step.name as StepName)
  if (teePath !== null) {
    try {
      const info = await stat(teePath)
      if (info.size > 0) return { kind: 'file-tail', path: teePath }
    } catch {
      /* falls through to JSON re-render */
    }
  }
  // Fallback: re-render the NDJSON sidecar into the warm-cache file. Covers
  // fixtures without a logger and runs that never persisted a tee (e.g. a
  // cancelled run with only `events.ndjson` on disk).
  const filePath = replayFilePath(opts, step.name)
  if (step.transcriptPath === undefined) {
    await writeReplayFile(
      opts,
      filePath,
      `── ${step.name} ──\r\n(no transcript recorded for this step)\r\n`,
    )
    return { kind: 'file-tail', path: filePath }
  }
  const text = await renderTranscriptToString({
    transcriptPath: toPath(`${opts.stateDir}/${step.transcriptPath}`),
    stepName: step.name,
    ...(opts.transcriptRenderer !== undefined
      ? { toTranscriptLines: opts.transcriptRenderer }
      : {}),
  })
  await writeReplayFile(opts, filePath, text)
  return { kind: 'file-tail', path: filePath }
}

async function resolveInteractiveReplaySpec(
  opts: RightPaneControllerOptions,
  step: StepRow & { kind: 'agent'; mode: 'interactive' },
): Promise<PaneSpec> {
  const registryProvided = opts.resumeRegistry !== undefined
  const runner = opts.resumeRegistry?.getRunnerForStep(step.name as StepName)
  const refusal = describeResumeRefusal({
    registryProvided,
    runner,
    runnerName: step.runnerName,
    sessionId: step.sessionId,
    sessionIdCaptureError: step.sessionIdCaptureError,
  })
  if (refusal !== undefined || runner === undefined) {
    const filePath = replayFilePath(opts, step.name)
    const text = refusal ?? 'resume unavailable — no runner wired into this host'
    await writeReplayFile(opts, filePath, `── ${step.name} ──\r\n${text}\r\n`)
    return { kind: 'file-tail', path: filePath }
  }
  const resumeFn = runner.resumeCommand as NonNullable<Runner['resumeCommand']>
  const sessionId = step.sessionId as string
  try {
    const cmd = await resumeFn(
      { cwd: opts.cwd, env: opts.env, prompt: '', extraArgs: [], mode: 'interactive' },
      sessionId,
    )
    return {
      kind: 'pty',
      argv: cmd.argv,
      ...(cmd.env !== undefined ? { env: cmd.env } : {}),
      cwd: opts.cwd,
    }
  } catch (err) {
    opts.stderr.write(`[orch tui] resume failed: ${String(err)}\n`)
    // Surface the failure in the warm-cache file so the user sees something
    // when they enter the step. The dispatcher additionally emits an error
    // banner so the message is durable above the steps grid.
    const filePath = replayFilePath(opts, step.name)
    await writeReplayFile(
      opts,
      filePath,
      `── ${step.name} ──\r\nresume failed — press f to return to live, q to close\r\n`,
    )
    return { kind: 'file-tail', path: filePath }
  }
}

function autonomousTeePath(logger: SessionLogger | undefined, stepName: StepName): Path | null {
  if (logger === undefined) return null
  if (logger.logsDir === null) return null
  return toPath(`${logger.logsDir}/agents/${stepName}/formatted_output.ansi`)
}

function replayFilePath(opts: RightPaneControllerOptions, stepName: string): Path {
  const safe = stepName.replace(/[^a-zA-Z0-9:_-]/g, '_').slice(0, 64)
  return toPath(`${opts.stateDir}/.replay/${safe}.txt`)
}

async function writeReplayFile(
  opts: RightPaneControllerOptions,
  filePath: Path,
  text: string,
): Promise<void> {
  const dirPath = toPath(`${opts.stateDir}/.replay`)
  await mkdir(dirPath, { recursive: true })
  await writeFile(filePath, text, 'utf8')
}

/**
 * Inputs the right-pane controller hands to the refusal-message dispatcher.
 *
 *  - `registryProvided` distinguishes "the CLI never wired a registry into
 *    this host" (R10) from "the registry is wired but doesn't yet contain
 *    this step" (R11 race surface).
 *  - `runner` is the live `Runner` instance resolved from the registry, or
 *    undefined when the registry has no entry for this step.
 *  - `runnerName` is the diagnostic label persisted on `StepEntry.runnerName`
 *    when the executor processed this step in any past run. Its absence is
 *    the R8 legacy signal (pre-feature steps lack the field entirely).
 *  - `sessionId` is the captured session/thread identifier the runner will
 *    consume on resume; absent when capture failed or didn't run.
 *  - `sessionIdCaptureError` is the typed three-value enum that surfaces a
 *    Codex capture failure (ambiguous / empty / error). Each value drives a
 *    distinct refusal message at the call site.
 */
interface ResumeRefusalContext {
  readonly registryProvided: boolean
  readonly runner: Runner | undefined
  readonly runnerName: string | undefined
  readonly sessionId: string | undefined
  readonly sessionIdCaptureError: 'ambiguous' | 'empty' | 'error' | undefined
}

function describeResumeRefusal(ctx: ResumeRefusalContext): string | undefined {
  // R10 — the CLI never wired a registry into this host. Tests that omit the
  // registry deliberately exercise this path to keep the legacy "no runner"
  // contract intact.
  if (!ctx.registryProvided) {
    return 'resume unavailable — no runner wired into this host'
  }
  if (ctx.runner === undefined) {
    // R8 vs R11 disambiguation. Pre-feature interactive steps have no
    // `runnerName` field at all — those are legacy. Steps written by this
    // feature always carry `runnerName`; their absence in the live registry
    // means the executor hasn't replayed them yet on `orch resume`.
    if (ctx.runnerName === undefined) {
      return (
        'resume unavailable — this step pre-dates the resume feature; ' +
        'only newer steps are resumable'
      )
    }
    return (
      'resume not ready yet — orch has not replayed this step in the current run; ' +
      'try again in a moment'
    )
  }
  if (typeof ctx.runner.resumeCommand !== 'function') {
    return `resume unavailable — runner "${ctx.runner.name}" does not support resume`
  }
  // R9 — typed Codex capture failure. Each variant gets a distinct refusal so
  // the user can act: ambiguous (concurrent Codex sessions can't be told
  // apart), empty (no rollout file ever appeared), error (orch's own bug).
  if (ctx.sessionIdCaptureError !== undefined) {
    switch (ctx.sessionIdCaptureError) {
      case 'ambiguous':
        return (
          'resume unavailable — Codex thread_id was not captured for this step ' +
          '(multiple Codex sessions started in the capture window; orch cannot tell which is yours)'
        )
      case 'empty':
        return (
          'resume unavailable — Codex thread_id was not captured for this step ' +
          '(no rollout file appeared within the capture window; Codex may have failed to start)'
        )
      case 'error':
        return (
          'resume unavailable — orch hit an internal error capturing the Codex thread_id; ' +
          'check the run logs'
        )
    }
  }
  if (ctx.sessionId === undefined) {
    return 'resume unavailable — no captured sessionId'
  }
  return undefined
}
