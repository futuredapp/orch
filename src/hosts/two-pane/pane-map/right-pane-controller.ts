// ---------------------------------------------------------------------------
// right-pane-controller (pane-map edition)
// ---------------------------------------------------------------------------
//
// Owns the `Map<SourceKey, {session, paneId}>` that records which hidden pane
// (and which per-source tmux session that pane lives in) is currently
// rendering each source. Every change to the visible right pane is a
// `tmux swap-pane` issued by `showSource`; no caller directly respawns or
// sendKeys-blasts the visible slot.
//
// The public surface is four pane-map methods (`registerSource`, `showSource`,
// `unregisterSource`, `followLive`) plus `onIntent` for the steps-view
// keypress channel + `teardownSessions` for the host's shutdown path. The
// host wires `registerSource` / `unregisterSource` from `step:start` /
// `step:complete` lifecycle events; `onIntent('enter')` resolves a `PaneSpec`
// per step kind, registers the replay source (warm-cached on second view),
// and swaps it in.
//
// **Per-source-session substrate (replaces the historical `orch-scratch`).**
// Each registered source gets its own tmux session named
// `orch-src-<sanitized-key>` on the per-run socket. The session's initial
// pane IS the source's process (the `tail -F …` for file-tail, the runner
// PTY for pty, a `cat` holder only for `placeholder`). `swap-pane` works
// cross-session because tmux pane ids are server-wide. This design
// eliminates `split-window` from the spawn path — and therefore eliminates
// the "no space for new pane" failure mode that bit run
// `r-2026-05-22-135756-tc`. See the per-source-tmux-sessions plan.
//
// **Visible-slot invariant.** `swap-pane` exchanges processes between two
// pane positions, but pane ids stay attached to their original processes.
// So after every swap, the pane id rendering in the visible slot changes.
// The controller tracks the *current* visible pane id (`visiblePaneId`)
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
import {
  createSourceSession,
  SOURCE_HOLDER_ARGV,
  sanitizeSessionName,
  teardownSourceSession,
} from './source-session.ts'

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
   * Width/height for per-source tmux sessions — forwarded to `new-session
   * -x / -y` so the source pane is sized at allocation. Matches the visible
   * `orch` session's dimensions at construct time.
   */
  readonly width: number
  readonly height: number
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

export interface UnregisterSourceOptions {
  /**
   * Skip the `"step X complete"` info banner that the `live → replay`
   * transform normally emits when the user was watching this source.
   * Used by the `step:failed` path so its error banner survives.
   */
  readonly suppressCompletionBanner?: boolean
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
   *
   * `suppressCompletionBanner` skips the `"step X complete"` info banner that
   * normally fires from the `live → replay` transform when the user was
   * watching this source. The failure path uses this so its durable error
   * banner is not overwritten by a misleading "complete" toast.
   */
  unregisterSource(key: SourceKey, options?: UnregisterSourceOptions): Promise<void>
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
   * (which kills the source session and the pane with it), so the host
   * queries the controller right after register.
   */
  getPaneId(key: SourceKey): PaneId | undefined
  /**
   * Tear down every per-source tmux session this controller created.
   * Called by `tmux-host`'s shutdown path BEFORE killing the visible `orch`
   * session so hidden source panes never outlive their swap target.
   *
   * Idempotent: tolerates already-gone sessions (the underlying
   * `TmuxService.killSession` adapter swallows "session not found"). Each
   * session's teardown is independent — one failure does not abort the rest.
   */
  teardownSessions(): Promise<void>
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
  /**
   * Controller-wide serial chain for `showSource`. Concurrent invocations
   * (step:start fires fire-and-forget `registerSource` from
   * `tmux-host.ts:746`; each registration's auto-swap-on-live block calls
   * `showSource`) otherwise read `visiblePaneId` before any prior swap's
   * write commits — every swap then targets the original right pane id and
   * the chain breaks, leaving the first source's content stuck in the
   * visible slot. Canonical reproduction: run r-2026-05-22-170039-0o. The
   * per-paneId `paneQueue` cannot close this race because each call enqueues
   * on a different `src` paneId.
   */
  let swapChain: Promise<void> = Promise.resolve()
  /** Currently active source key. Undefined when nothing has been swapped in. */
  let currentKey: SourceKey | undefined
  /**
   * Per-source entry: which tmux session hosts this source, plus the pane id
   * inside it. Keyed on `sourceKeyToString(key)` so structural equality
   * works. The pane id is sticky to its process — `swap-pane` does not
   * rewrite it, so this entry remains the canonical reference for every
   * subsequent swap and for `killSession` at unregister time.
   */
  interface PaneEntry {
    readonly session: string
    readonly paneId: PaneId
  }
  const panes = new Map<string, PaneEntry>()
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
      // Never write to opts.stderr while the parent process shares a TTY with
      // `tmux attach-session`: bytes leak into the active tmux pane. The
      // failure is durably recorded via logLifecycle (file sink, not fd-2).
      logLifecycle({ type: 'tui-overlay-write-failed', ...errorLifecycleFields(err) })
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

  /**
   * Build the argv for one source's initial pane. `file-tail` follows the
   * tee with `tail -n <backfill> -F <path>`; `pty` runs the runner argv
   * directly; `placeholder` runs the dormant `cat` holder. The returned
   * argv is the initial pane's *process* — no `split-window` ever runs
   * against the source session, so the historical "no space for new pane"
   * failure mode is gone by construction.
   */
  const commandForSpec = (spec: PaneSpec, key: SourceKey): readonly string[] => {
    if (key.type === 'placeholder') return SOURCE_HOLDER_ARGV
    if (spec.kind === 'file-tail') {
      return ['tail', '-n', TAIL_BACKFILL_LINES, '-F', spec.path]
    }
    return spec.argv
  }

  const spawnHiddenSource = async (spec: PaneSpec, key: SourceKey): Promise<PaneEntry> => {
    const sessionName = sanitizeSessionName(sourceKeyToString(key))
    const command = commandForSpec(spec, key)
    const env = spec.kind === 'pty' ? spec.env : undefined
    const cwd = spec.kind === 'pty' ? spec.cwd : undefined
    const handle = await createSourceSession({
      tmux: opts.tmux,
      socket: opts.socket,
      sessionName,
      width: opts.width,
      height: opts.height,
      command,
      ...(env !== undefined ? { env } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
    })
    return { session: handle.session, paneId: handle.paneId }
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
      const sessionName = sanitizeSessionName(skey)
      logLifecycle({
        type: 'pane-spawn-start',
        sourceKey: skey,
        specKind: spec.kind,
        socket: opts.socket,
        session: sessionName,
      })
      let entry: PaneEntry
      try {
        entry = await spawnHiddenSource(spec, key)
      } catch (err) {
        logLifecycle({
          type: 'pane-spawn-failed',
          sourceKey: skey,
          specKind: spec.kind,
          socket: opts.socket,
          session: sessionName,
          ...errorLifecycleFields(err),
        })
        // Also surface as a source-session-create-failed event so the
        // lifecycle log makes the failure mode explicit — sibling sources
        // are unaffected (KTD3: per-source isolation).
        logLifecycle({
          type: 'source-session-create-failed',
          sourceKey: skey,
          session: sessionName,
          ...errorLifecycleFields(err),
        })
        throw err
      }
      panes.set(skey, entry)
      keyByString.set(skey, key)
      if (key.type === 'live' || key.type === 'interactive') {
        liveSources.push(skey)
      }
      logLifecycle({
        type: 'source-session-created',
        sourceKey: skey,
        session: entry.session,
        paneId: entry.paneId,
      })
      logLifecycle({ type: 'pane-spawned', sourceKey: skey, paneId: entry.paneId })
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

  const doShowSource = async (key: SourceKey): Promise<void> => {
    if (stopped) return
    const skey = sourceKeyToString(key)
    const entry = panes.get(skey)
    if (entry === undefined) {
      logLifecycle({ type: 'right-pane-swap-miss', sourceKey: skey })
      return
    }
    if (currentKey !== undefined && sourceKeyToString(currentKey) === skey) return
    // Sequential single-pane enqueue: visible-pane settles first (no work),
    // then hidden-pane carries the swap. Both calls share the global pane
    // queue so any pending writes to either pane finish before the swap.
    // `swap-pane` works across sessions because tmux pane ids are
    // server-wide — entry.paneId lives inside the per-source session, dst
    // lives in the visible `orch` session, the swap exchanges them.
    const src = entry.paneId
    const dst = visiblePaneId
    logLifecycle({
      type: 'right-pane-swap-start',
      to: skey,
      srcPaneId: src,
      dstPaneId: dst,
    })
    try {
      await opts.paneQueue.enqueue(dst, () => Promise.resolve())
      await opts.paneQueue.enqueue(src, () => opts.tmux.swapPane({ socket: opts.socket, src, dst }))
    } catch (err) {
      logLifecycle({
        type: 'right-pane-swap-failed',
        to: skey,
        srcPaneId: src,
        dstPaneId: dst,
        ...errorLifecycleFields(err),
      })
      throw err
    }
    // After the swap: the hidden pane id now occupies the visible slot, and
    // the previously-visible pane id has moved to the hidden slot. We track
    // which pane id is visible so subsequent swaps target it.
    visiblePaneId = src
    currentKey = key
    logLifecycle({ type: 'right-pane-swap', to: skey, paneId: src })
  }

  const showSource = (key: SourceKey): Promise<void> => {
    // Serialize every swap behind `swapChain` so the read of `visiblePaneId`,
    // the swap, and the write of `visiblePaneId` are atomic across concurrent
    // callers. `prev.catch` swallows upstream rejections so one failed swap
    // does not poison every later showSource — the rejection still surfaces
    // to its own caller via `next`.
    const next = swapChain.catch(() => undefined).then(() => doShowSource(key))
    swapChain = next.catch(() => undefined)
    return next
  }

  const removeFromLiveSources = (skey: string): void => {
    const idx = liveSources.indexOf(skey)
    if (idx >= 0) liveSources.splice(idx, 1)
  }

  const transformLiveToReplay = (
    liveKey: SourceKey & { readonly type: 'live' },
    skey: string,
    entry: PaneEntry,
  ): void => {
    const replayKey: SourceKey = { type: 'replay', stepName: liveKey.stepName }
    const replaySkey = sourceKeyToString(replayKey)
    panes.delete(skey)
    panes.set(replaySkey, entry)
    keyByString.delete(skey)
    keyByString.set(replaySkey, replayKey)
    removeFromLiveSources(skey)
    if (currentKey !== undefined && sourceKeyToString(currentKey) === skey) {
      currentKey = replayKey
    }
    logLifecycle({ type: 'live-to-replay-transform', from: skey, to: replaySkey })
    // Note: the per-source session is *not* renamed in tmux — its name still
    // reflects the original `live:` key. Replay tooling that greps logs for
    // pane-id-by-session must consult `keyByString` (or the controller's
    // entry shape), not parse the session name. The session stays alive
    // because nothing kills it; the pane id is sticky to the tail process.
  }

  // Lazily register the always-present placeholder source. Used by
  // killHiddenSource to keep the visible slot alive when the soon-to-be-
  // killed pane is the current visible source. The placeholder source has
  // no underlying byte stream; its session runs a dormant `cat` holder so
  // the pane stays alive across swap-out periods. Idempotent — second call
  // is a no-op.
  const ensurePlaceholderRegistered = async (): Promise<void> => {
    const placeholderKey: SourceKey = { type: 'placeholder' }
    const skey = sourceKeyToString(placeholderKey)
    if (panes.has(skey)) return
    // spec.path here is unused — commandForSpec routes `placeholder` to the
    // `cat` holder argv regardless. We pass a benign file-tail spec to
    // satisfy the type checker; the spec.kind field is not read for
    // placeholder.
    const entry = await spawnHiddenSource(
      { kind: 'file-tail', path: toPath('/dev/null') },
      placeholderKey,
    )
    panes.set(skey, entry)
    keyByString.set(skey, placeholderKey)
    logLifecycle({
      type: 'source-session-created',
      sourceKey: skey,
      session: entry.session,
      paneId: entry.paneId,
    })
    logLifecycle({ type: 'pane-spawned', sourceKey: skey, paneId: entry.paneId })
  }

  const killHiddenSource = async (skey: string, entry: PaneEntry): Promise<void> => {
    if (currentKey !== undefined && sourceKeyToString(currentKey) === skey) {
      // The pane we are about to kill is currently in the visible slot
      // (due to a prior swap). Killing it without first relocating the
      // visible slot collapses the right pane and orphans visiblePaneId
      // at a dead pane id — every subsequent swapPane then fails with
      // `can't find pane: <entry.paneId>`. Ensure a placeholder source
      // exists, swap to it, then proceed with the kill (which now lands
      // on the hidden slot, not the visible one).
      logLifecycle({
        type: 'visible-pane-relocation-start',
        from: skey,
        paneId: entry.paneId,
      })
      await ensurePlaceholderRegistered()
      const placeholderKey: SourceKey = { type: 'placeholder' }
      if (panes.has(sourceKeyToString(placeholderKey))) await showSource(placeholderKey)
      logLifecycle({
        type: 'visible-pane-relocation-complete',
        from: skey,
        paneId: entry.paneId,
      })
    }
    panes.delete(skey)
    keyByString.delete(skey)
    removeFromLiveSources(skey)
    logLifecycle({
      type: 'source-session-teardown-start',
      sourceKey: skey,
      session: entry.session,
      paneId: entry.paneId,
    })
    let torndown = false
    try {
      await teardownSourceSession(opts.tmux, { socket: opts.socket, session: entry.session })
      torndown = true
    } catch (err) {
      // Lifecycle log only — no fd-2 write (would bleed into the attached
      // tmux client's terminal grid).
      logLifecycle({
        type: 'source-session-teardown-failed',
        sourceKey: skey,
        session: entry.session,
        paneId: entry.paneId,
        ...errorLifecycleFields(err),
      })
    }
    logLifecycle({
      type: 'source-session-torndown',
      sourceKey: skey,
      session: entry.session,
      paneId: entry.paneId,
      torndown,
    })
    // Killing the session destroys its pane along with it — preserve the
    // historical `pane-killed` event so replay tooling and finding-doc
    // greps continue to fire on per-source unregistrations.
    logLifecycle({
      type: 'pane-killed',
      sourceKey: skey,
      paneId: entry.paneId,
      killed: torndown,
    })
  }

  const unregisterSource = async (
    key: SourceKey,
    options?: UnregisterSourceOptions,
  ): Promise<void> => {
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
    const entry = panes.get(skey)
    if (entry === undefined) {
      logLifecycle({ type: 'source-unregister-miss', sourceKey: skey })
      return
    }
    if (key.type === 'live') {
      logLifecycle({
        type: 'source-unregister-live-to-replay',
        sourceKey: skey,
        paneId: entry.paneId,
      })
      // Transform: rekey the same per-source session under the replay key.
      // No kill. The pane continues to tail the (now-frozen) tee; subsequent
      // revisits are O(1).
      const wasCurrent = currentKey !== undefined && sourceKeyToString(currentKey) === skey
      transformLiveToReplay(key, skey, entry)
      // U5: if the user was watching this live source, surface the frozen-
      // transcript cue — view-mode flip is always correct; the info banner is
      // skipped on the failure path so its durable error banner is the
      // user-visible message instead of a misleading "step X complete" toast.
      if (wasCurrent) {
        await setViewMode({ mode: 'replay', stepName: key.stepName })
        if (options?.suppressCompletionBanner !== true) {
          await emitBanner({
            kind: 'info',
            text: `step ${key.stepName} complete`,
            ttlMs: 4000,
          })
        }
      }
      return
    }
    // Interactive / rollup / placeholder / replay: kill the per-source
    // session (which destroys its pane) and drop the entry. If the current
    // key is this one, swap to placeholder FIRST so the visible slot
    // doesn't reference a dead pane.
    logLifecycle({ type: 'source-unregister-kill', sourceKey: skey, paneId: entry.paneId })
    await killHiddenSource(skey, entry)
  }

  const teardownSessions = async (): Promise<void> => {
    // Drain the per-source session map. Each session's teardown is
    // independent — one already-gone session must not block the others, so
    // we wrap every kill in a per-entry try/catch. Idempotency at the
    // adapter level (`TmuxService.killSession` swallows "session not
    // found") covers the racing-teardown case.
    const entries = Array.from(panes.entries())
    panes.clear()
    keyByString.clear()
    liveSources.length = 0
    for (const [skey, entry] of entries) {
      logLifecycle({
        type: 'source-session-teardown-start',
        sourceKey: skey,
        session: entry.session,
        paneId: entry.paneId,
      })
      try {
        await teardownSourceSession(opts.tmux, {
          socket: opts.socket,
          session: entry.session,
        })
        logLifecycle({
          type: 'source-session-torndown',
          sourceKey: skey,
          session: entry.session,
          paneId: entry.paneId,
          torndown: true,
        })
      } catch (err) {
        logLifecycle({
          type: 'source-session-teardown-failed',
          sourceKey: skey,
          session: entry.session,
          paneId: entry.paneId,
          ...errorLifecycleFields(err),
        })
        logLifecycle({
          type: 'source-session-torndown',
          sourceKey: skey,
          session: entry.session,
          paneId: entry.paneId,
          torndown: false,
        })
      }
    }
  }

  /**
   * Walk `liveSources` newest-first and show the first source matching
   * `accept` whose backing session is still alive. Each candidate is
   * liveness-checked before we swap to it: a runner whose session was torn
   * down leaves a stale `liveSources` entry, and swapping to its dead pane
   * would crash exactly like the Enter path did. `liveSources` mutates as
   * `invalidateSourceIfSessionGone` forgets dead entries, so we iterate over a
   * snapshot. Returns true if a source was shown.
   */
  const showNewestLiveSource = async (accept: (key: SourceKey) => boolean): Promise<boolean> => {
    for (const skey of [...liveSources].reverse()) {
      if (skey === undefined) continue
      await invalidateSourceIfSessionGone(skey)
      if (!panes.has(skey)) continue
      const key = keyByString.get(skey)
      if (key !== undefined && accept(key)) {
        await showSource(key)
        return true
      }
    }
    return false
  }

  const swapToNewestLivePane = async (): Promise<boolean> => {
    const rollupKey: SourceKey = { type: 'rollup' }
    const rollupSkey = sourceKeyToString(rollupKey)
    await invalidateSourceIfSessionGone(rollupSkey)
    if (panes.has(rollupSkey)) {
      await showSource(rollupKey)
      return true
    }
    // Prefer a truly-live source. dispatchEnter on a past interactive step
    // re-registers `interactive:<step>` and registerSource pushes both `live`
    // and `interactive` keys onto liveSources; without this preference, `f`
    // after entering a past interactive step short-circuits on the replay key.
    if (await showNewestLiveSource((key) => key.type === 'live')) return true
    // No truly-live source. Fall back to most-recent still-alive source so
    // workflows with only interactive steps still respond to `f`.
    if (await showNewestLiveSource(() => true)) return true
    const placeholderKey: SourceKey = { type: 'placeholder' }
    if (panes.has(sourceKeyToString(placeholderKey))) {
      await showSource(placeholderKey)
      return true
    }
    return false
  }

  const followLive = async (): Promise<void> => {
    if (stopped) return
    // `f` ("snap to live") must restore BOTH the right-pane source and the
    // left-pane footer mode. Swapping the pane without flipping the view mode
    // leaves the footer stuck on `⏸ viewing <step>` (findings P-1).
    if (await swapToNewestLivePane()) await setViewMode({ mode: 'live' })
  }

  /**
   * Drop a source from every index unconditionally. Used both when a session
   * probe proves the source is gone and when a `swap-pane` answers "can't find
   * pane" (the source's process exited out-of-band, e.g. an interactive resume
   * pty that finished while it was hidden — incident r-2026-05-25-171216-nu).
   */
  const forgetSource = (skey: string): void => {
    panes.delete(skey)
    keyByString.delete(skey)
    removeFromLiveSources(skey)
    if (currentKey !== undefined && sourceKeyToString(currentKey) === skey) {
      currentKey = undefined
    }
  }

  /**
   * True for the tmux failure raised when a swap targets a pane whose process
   * exited and tmux already destroyed it. `hasSession` cannot detect this when
   * `remain-on-exit` keeps the session alive around the dead pane, so it is the
   * canonical signal that a cached entry must be forgotten and re-resolved.
   */
  const isStalePaneError = (err: unknown): boolean =>
    err instanceof TmuxCommandError && /can't find pane/i.test(err.stderr)

  const invalidateSourceIfSessionGone = async (skey: string): Promise<void> => {
    const entry = panes.get(skey)
    if (entry === undefined) return
    const sessionAlive = await opts.tmux.hasSession({
      socket: opts.socket,
      session: entry.session,
    })
    if (sessionAlive) return
    forgetSource(skey)
    logLifecycle({
      type: 'source-session-stale',
      sourceKey: skey,
      session: entry.session,
      paneId: entry.paneId,
    })
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

  /**
   * If the step has a live/interactive source already cached, tune in to it
   * and return true. Returns false when there is none, or when the cached
   * source's pane had died and was refreshed away (caller falls through to the
   * replay path, which re-registers a fresh source).
   *
   * The step may be currently running — a `live:<step>`/`interactive:<step>`
   * source is registered while it executes, and the replay path's `lookupStep`
   * can't satisfy an in-flight step with no persisted entry. It may also be a
   * past interactive step whose warm-cached resume pane has no teardown owner
   * and exited out-of-band; both are handled here so we never swap to a dead
   * pane (incident r-2026-05-25-171216-nu).
   */
  const showCachedRunningSource = async (stepName: string): Promise<boolean> => {
    const liveKey: SourceKey = { type: 'live', stepName: stepName as StepName }
    const interactiveKey: SourceKey = { type: 'interactive', stepName: stepName as StepName }
    await invalidateSourceIfSessionGone(sourceKeyToString(liveKey))
    await invalidateSourceIfSessionGone(sourceKeyToString(interactiveKey))
    const liveExists = panes.has(sourceKeyToString(liveKey))
    const interactiveExists = panes.has(sourceKeyToString(interactiveKey))
    if (!liveExists && !interactiveExists) return false
    const key = liveExists ? liveKey : interactiveKey
    try {
      await showSource(key)
      await setViewMode({ mode: 'live' })
      logLifecycle({ type: 'live-pane-opened', stepName, sourceKey: sourceKeyToString(key) })
      return true
    } catch (err) {
      // `hasSession` can report alive while the pane inside it is dead
      // (remain-on-exit keeps the session up), so the swap still fails with
      // "can't find pane". Forget the stale source and let the caller fall
      // through to re-register. Any other failure propagates → error banner.
      if (!isStalePaneError(err)) throw err
      forgetSource(sourceKeyToString(key))
      logLifecycle({ type: 'live-pane-stale-refresh', stepName, sourceKey: sourceKeyToString(key) })
      return false
    }
  }

  /**
   * Swap to a replay source, recovering from a warm-cached pane that died
   * out-of-band. remain-on-exit keeps the pane's session ALIVE, so the
   * session guard can't drop it and the swap fails with "can't find pane".
   * Forget the stale source, re-register a fresh one, and retry once. Any
   * other failure propagates to dispatchEnter's banner (r-2026-05-25-171216-nu).
   */
  const showReplaySourceWithStaleRefresh = async (
    step: StepRow,
    replayKey: SourceKey,
  ): Promise<void> => {
    try {
      await showSource(replayKey)
    } catch (err) {
      if (!isStalePaneError(err)) throw err
      const replaySkey = sourceKeyToString(replayKey)
      forgetSource(replaySkey)
      logLifecycle({
        type: 'replay-pane-stale-refresh',
        stepName: step.name,
        sourceKey: replaySkey,
      })
      await registerSource(replayKey, await resolveReplaySpec(opts, step))
      await showSource(replayKey)
    }
  }

  const dispatchEnter = async (stepName: string): Promise<void> => {
    if (stopped) return

    // One try/catch around the whole body. The short-circuit used to sit
    // outside it; a `swap-pane` failure there escaped `dispatchEnter`, and
    // because `onIntent` fires this as `void dispatchEnter(...)` it became an
    // unhandled rejection whose stack Node wrote to fd-2 — the TTY shared with
    // the tmux client — bleeding over the live TUI (r-2026-05-25-171216-nu).
    // Every failure must surface as a banner, never escape.
    try {
      const step = await lookupStep(stepName)
      if (step === undefined) {
        // Not persisted → the step is in-flight (lookupStep projects with an
        // empty overlay, so any persisted hit is a completed/past step). Only
        // an in-flight step may tune into its cached live/interactive source.
        // A completed step's leftover remain-on-exit pane must NOT short-circuit
        // here: that flips the footer to `{ mode: 'live' }`, jumping the left
        // pane's committed highlight to the last step while the right pane shows
        // the stale pane (run r-2026-05-27-154145-nk). It replays below instead.
        if (await showCachedRunningSource(stepName)) return
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
      await invalidateSourceIfSessionGone(replaySkey)
      if (!panes.has(replaySkey)) {
        const spec = await resolveReplaySpec(opts, step)
        await registerSource(replayKey, spec)
      }
      await showReplaySourceWithStaleRefresh(step, replayKey)
      await setViewMode({ mode: 'replay', stepName: step.name })
      logLifecycle({
        type: 'replay-pane-opened',
        stepName,
        sourceKey: sourceKeyToString(replayKey),
      })
      orchLog(opts.logger, 'replay-kind-dispatched', { stepName, kind: step.kind })
    } catch (err) {
      // The banner is the user-visible sink; the lifecycle log is the durable
      // record. Never write to opts.stderr — see writeTuiOverlay for the
      // bleed mechanism.
      logLifecycle({
        type: 'replay-pane-failed',
        stepName,
        ...errorLifecycleFields(err),
      })
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
    return panes.get(sourceKeyToString(key))?.paneId
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
    teardownSessions,
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
    // No fd-2 write — would leak into the attached tmux client. The warm-
    // cache file below surfaces the failure inside the pane; the dispatcher
    // additionally emits an error banner so the message is durable above
    // the steps grid.
    void opts.logger
      ?.append('lifecycle', {
        type: 'resume-failed',
        stepName: step.name,
        ...errorLifecycleFields(err),
      })
      .catch(() => {})
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
