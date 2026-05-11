// ---------------------------------------------------------------------------
// right-pane-controller (pane-map edition)
// ---------------------------------------------------------------------------
//
// Owns the `Map<SourceKey, PaneId>` that records which hidden pane in the
// per-run scratch session is currently rendering each source. Every change
// to the visible right pane is a `tmux swap-pane` issued by `showSource`;
// no caller directly respawns or sendKeys-blasts the visible slot.
//
// **U3 status (pure refactor):** the new public methods
// (`registerSource`/`showSource`/`unregisterSource`/`followLive`/
// `emitBanner`) exist on the surface, but the host's lifecycle hooks
// haven't been rewired yet. Until U5 lands, `onIntent` continues to use
// the legacy respawn-on-rightPaneId paths verbatim ported from the old
// controller. The new methods are wired to scratch-session pane spawns;
// U5/U6/U7/U8 progressively rewire `onIntent` and the host's lifecycle
// hooks to drive them.
//
// **Visible-slot invariant.** `swap-pane` exchanges processes between two
// pane positions, but pane ids stay attached to their original processes.
// So after every swap, the pane id rendering in the visible slot changes.
// The controller tracks the *current* visible pane id (`#visiblePaneId`)
// and updates it after every swap; future swaps target the up-to-date
// destination.

import { mkdir, writeFile } from 'node:fs/promises'
import { orchLog, type SessionLogger } from '../../../observability/index.ts'
import type { Runner } from '../../../runners/index.ts'
import type { PaneId, SocketName, TmuxService } from '../../../services/tmux/index.ts'
import { type Path, path as toPath } from '../../../services/types.ts'
import type { RunId, StateStore, StepEntry } from '../../../state/index.ts'
import { renderKindDetails } from '../kind-details.tsx'
import type { PaneQueue } from '../pane-queue.ts'
import { resolveCommandPaneSource } from '../replay-command-pane.ts'
import { renderTranscriptToString } from '../replay-transcript.ts'
import { projectStepsView, type StepRow, type StepsIntent } from '../steps-view/index.ts'
import { type PaneSpec, type SourceKey, sourceKeyToString } from './pane-spec.ts'
import type { ScratchSessionHandle } from './scratch-session.ts'

const PLACEHOLDER_CMD = 'cat'
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
   * by the new `registerSource` / `showSource` / `unregisterSource` /
   * `followLive` methods (the pane-map surface). Optional because the
   * legacy `onIntent` path doesn't need it — pre-U5 tests that exercise
   * only `onIntent` can omit it. The host always provides it in
   * production.
   */
  readonly scratchSession?: ScratchSessionHandle
  /**
   * Renderer for autonomous-agent transcripts. The CLI defaults this to
   * Claude's `toClaudeTranscriptLines`. Without it, replay falls back to a
   * JSON stringify which is unreadable.
   */
  readonly transcriptRenderer?: Runner['toTranscriptLines']
  /**
   * Resume launcher. When provided, agent-interactive Enter calls
   * `resumeRunner.resumeCommand(...)` and respawns the right pane with the
   * resulting argv. Without it, agent-interactive Enter shows the refusal
   * message.
   */
  readonly resumeRunner?: Runner
  /**
   * Busy gate. The host flips this true while a step is mid-flight on the
   * right pane. Enter is refused with a footer message + `replay-blocked-
   * busy` log when the gate returns true.
   *
   * **U3 status:** kept until U5 lands the new swap-based live path. The
   * busy gate is structurally unnecessary in the swap model (past-step
   * Enter is safe by construction), but until `onIntent('enter')` is
   * migrated to swap-pane the legacy respawn path can still clobber a
   * live transcript — so the gate stays.
   */
  readonly isRightPaneBusy?: () => boolean
}

export interface RightPaneController {
  /** Wire this into `startStepsView`'s `onIntent`. */
  onIntent(intent: StepsIntent): void
  /**
   * Register a new source. Spawns a hidden pane in the scratch session;
   * stores the pane id under the source key. Idempotent — calling with the
   * same key is a no-op.
   *
   * `U3 dead-code surface`: not yet called by the host. U5/U6/U7 wire this
   * to lifecycle hooks.
   */
  registerSource(key: SourceKey, spec: PaneSpec): Promise<void>
  /**
   * Swap the visible right pane to the hidden pane that's rendering `key`.
   * No-op if `currentKey === key` or `key` is not in the map.
   *
   * `U3 dead-code surface`: not yet called by the host.
   */
  showSource(key: SourceKey): Promise<void>
  /**
   * Remove a source from the map. The rule is type-specific:
   *   - `live`: rekeyed to `replay` (warm cache, no kill).
   *   - `interactive`/`rollup`/`placeholder`: kill the hidden pane.
   *
   * `U3 dead-code surface`: not yet called by the host.
   */
  unregisterSource(key: SourceKey): Promise<void>
  /**
   * Swap to the most-recently-registered live or interactive source, or to
   * rollup if registered, or to placeholder if neither exists.
   *
   * `U3 dead-code surface`: not yet called by the host.
   */
  followLive(): Promise<void>
  /** Tear down: drop references, stop accepting intents. */
  stop(): Promise<void>
}

export function createRightPaneController(opts: RightPaneControllerOptions): RightPaneController {
  let stopped = false
  let priorEnterFired = false

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

  const logLifecycle = (record: Readonly<Record<string, unknown>>): void => {
    void opts.logger?.append('lifecycle', record).catch(() => {})
  }

  // ---------------------------------------------------------------------------
  // New public methods (U3 dead-code surface; wired in U5+)
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
    if (panes.has(skey)) return
    const paneId = await spawnHiddenPane(spec)
    panes.set(skey, paneId)
    keyByString.set(skey, key)
    if (key.type === 'live' || key.type === 'interactive') {
      liveSources.push(skey)
    }
    logLifecycle({ type: 'pane-spawned', sourceKey: skey, paneId })
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
    await opts.paneQueue.enqueue(dst, () => Promise.resolve())
    await opts.paneQueue.enqueue(hidden, () =>
      opts.tmux.swapPane({ socket: opts.socket, src: hidden, dst }),
    )
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

  const killHiddenSource = async (skey: string, hidden: PaneId): Promise<void> => {
    if (currentKey !== undefined && sourceKeyToString(currentKey) === skey) {
      const placeholderKey: SourceKey = { type: 'placeholder' }
      if (panes.has(sourceKeyToString(placeholderKey))) await showSource(placeholderKey)
    }
    panes.delete(skey)
    keyByString.delete(skey)
    removeFromLiveSources(skey)
    try {
      await opts.tmux.killPane({ socket: requireScratchSession().socket, target: hidden })
    } catch (err) {
      opts.stderr.write(`[orch tui] killPane failed for ${skey}: ${String(err)}\n`)
    }
    logLifecycle({ type: 'pane-killed', sourceKey: skey, paneId: hidden })
  }

  const unregisterSource = async (key: SourceKey): Promise<void> => {
    if (stopped) return
    const skey = sourceKeyToString(key)
    const hidden = panes.get(skey)
    if (hidden === undefined) return
    if (key.type === 'live') {
      // Transform: rekey the same hidden pane under the replay key. No kill.
      // The pane continues to tail the (now-frozen) tee; subsequent revisits
      // are O(1).
      transformLiveToReplay(key, skey, hidden)
      return
    }
    // Interactive / rollup / placeholder / replay: kill the hidden pane and
    // drop the entry. If the current key is this one, swap to placeholder
    // FIRST so the visible slot doesn't reference a dead pane.
    await killHiddenSource(skey, hidden)
  }

  const followLive = async (): Promise<void> => {
    if (stopped) return
    const rollupKey: SourceKey = { type: 'rollup' }
    if (panes.has(sourceKeyToString(rollupKey))) {
      await showSource(rollupKey)
      return
    }
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
  // Legacy onIntent path (verbatim port from old controller).
  // Kept until U5/U6/U8 rewire onIntent to use the new methods above.
  // ---------------------------------------------------------------------------

  const closeReplay = async (): Promise<void> => {
    if (!priorEnterFired) return
    priorEnterFired = false
    logLifecycle({ type: 'replay-pane-closing' })
    try {
      await opts.paneQueue.enqueue(opts.rightPaneId, () =>
        opts.tmux.respawnPane({
          socket: opts.socket,
          target: opts.rightPaneId,
          argv: [PLACEHOLDER_CMD],
          killRunning: true,
        }),
      )
    } catch (err) {
      opts.stderr.write(`[orch tui] follow-live respawn failed: ${String(err)}\n`)
      logLifecycle({ type: 'replay-pane-close-failed', error: String(err) })
    }
  }

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

  const writeBusyFooter = async (stepName: string): Promise<void> => {
    const message = `── ${stepName} ──\r\n⏎ disabled while step running — press q to quit\r\n`
    try {
      await opts.paneQueue.enqueue(opts.rightPaneId, () =>
        opts.tmux.sendKeys({
          socket: opts.socket,
          target: opts.rightPaneId,
          keys: [message],
        }),
      )
    } catch (err) {
      opts.stderr.write(`[orch tui] busy-footer send failed: ${String(err)}\n`)
    }
  }

  const dispatchEnter = async (stepName: string): Promise<void> => {
    if (stopped) return
    if (opts.isRightPaneBusy?.() === true) {
      logLifecycle({ type: 'replay-blocked-busy', stepName })
      await writeBusyFooter(stepName)
      return
    }

    const step = await lookupStep(stepName)
    if (step === undefined) {
      logLifecycle({ type: 'replay-lookup-miss', stepName })
      return
    }

    try {
      await dispatchByKind(opts, step)
      priorEnterFired = true
      logLifecycle({
        type: 'replay-pane-opened',
        stepName,
        paneId: String(opts.rightPaneId),
      })
      orchLog(opts.logger, 'replay-kind-dispatched', { stepName, kind: step.kind })
    } catch (err) {
      opts.stderr.write(`[orch tui] replay dispatch failed: ${String(err)}\n`)
      logLifecycle({ type: 'replay-pane-failed', stepName, error: String(err) })
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
      void closeReplay()
      return
    }
    if (intent.type === 'quit') {
      void closeReplay()
    }
  }

  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
  }

  return {
    onIntent,
    registerSource,
    showSource,
    unregisterSource,
    followLive,
    stop,
  }
}

// ---------------------------------------------------------------------------
// Legacy per-kind dispatch helpers. Will be replaced by `resolveReplaySpec`
// in U8 (commit/worktree/ask write a .replay/<step>.txt file; tail -F over
// it).
// ---------------------------------------------------------------------------

async function dispatchByKind(opts: RightPaneControllerOptions, step: StepRow): Promise<void> {
  if (step.kind === 'agent') {
    if (step.mode === 'interactive') {
      await dispatchAgentInteractive(opts, step)
      return
    }
    const transcriptPath = step.transcriptPath
    if (transcriptPath === undefined) {
      await respawnCatInline(
        opts,
        step.name,
        `── ${step.name} ──\r\n(no transcript recorded for this step)\r\n`,
      )
      return
    }
    const text = await renderTranscriptToString({
      transcriptPath: toPath(`${opts.stateDir}/${transcriptPath}`),
      stepName: step.name,
      ...(opts.transcriptRenderer !== undefined
        ? { toTranscriptLines: opts.transcriptRenderer }
        : {}),
    })
    await respawnCatInline(opts, step.name, text)
    return
  }
  if (step.kind === 'command') {
    const paneLogPath = toPath(`${opts.stateDir}/logs/tmux/${opts.rightPaneId}.log`)
    const source = await resolveCommandPaneSource({ stepName: step.name, paneLogPath })
    if (source.kind === 'file') {
      await respawnCatPath(opts, source.path)
      return
    }
    await respawnCatInline(opts, step.name, source.text)
    return
  }
  if (step.kind === 'commit' || step.kind === 'worktree' || step.kind === 'ask') {
    const payload = renderKindDetails({ step })
    await respawnCatInline(opts, step.name, payload)
    return
  }
}

function replayFilePath(opts: RightPaneControllerOptions, stepName: string): Path {
  const safe = stepName.replace(/[^a-zA-Z0-9:_-]/g, '_').slice(0, 64)
  return toPath(`${opts.stateDir}/.replay/${safe}.txt`)
}

async function respawnCatInline(
  opts: RightPaneControllerOptions,
  stepName: string,
  text: string,
): Promise<void> {
  const filePath = replayFilePath(opts, stepName)
  const dirPath = toPath(`${opts.stateDir}/.replay`)
  await opts.paneQueue.enqueue(opts.rightPaneId, async () => {
    await mkdir(dirPath, { recursive: true })
    await writeFile(filePath, text, 'utf8')
    await opts.tmux.respawnPane({
      socket: opts.socket,
      target: opts.rightPaneId,
      argv: [PLACEHOLDER_CMD, filePath],
      killRunning: true,
      cwd: opts.cwd,
    })
  })
}

async function respawnCatPath(opts: RightPaneControllerOptions, filePath: Path): Promise<void> {
  await opts.paneQueue.enqueue(opts.rightPaneId, () =>
    opts.tmux.respawnPane({
      socket: opts.socket,
      target: opts.rightPaneId,
      argv: [PLACEHOLDER_CMD, filePath],
      killRunning: true,
      cwd: opts.cwd,
    }),
  )
}

function describeResumeRefusal(
  runner: Runner | undefined,
  sessionId: string | undefined,
): string | undefined {
  if (runner === undefined) {
    return 'resume unavailable — no runner wired into this host'
  }
  if (typeof runner.resumeCommand !== 'function') {
    return `resume unavailable — runner "${runner.name}" does not support resume`
  }
  if (sessionId === undefined) {
    return 'resume unavailable — this step has no captured sessionId'
  }
  return undefined
}

async function dispatchAgentInteractive(
  opts: RightPaneControllerOptions,
  step: StepRow & { kind: 'agent'; mode: 'interactive' },
): Promise<void> {
  const refusal = describeResumeRefusal(opts.resumeRunner, step.sessionId)
  if (refusal !== undefined) {
    await respawnCatInline(opts, step.name, `── ${step.name} ──\r\n${refusal}\r\n`)
    return
  }
  const runner = opts.resumeRunner as Runner
  const resumeFn = runner.resumeCommand as NonNullable<Runner['resumeCommand']>
  const sessionId = step.sessionId as string
  try {
    const cmd = await resumeFn(
      { cwd: opts.cwd, env: opts.env, prompt: '', extraArgs: [], mode: 'interactive' },
      sessionId,
    )
    await opts.paneQueue.enqueue(opts.rightPaneId, () =>
      opts.tmux.respawnPane({
        socket: opts.socket,
        target: opts.rightPaneId,
        argv: cmd.argv,
        killRunning: true,
        env: cmd.env,
        cwd: opts.cwd,
      }),
    )
  } catch (err) {
    opts.stderr.write(`[orch tui] resume failed: ${String(err)}\n`)
    await respawnCatInline(
      opts,
      step.name,
      `── ${step.name} ──\r\nresume failed — press f to return to live, q to close\r\n`,
    )
  }
}
