// ---------------------------------------------------------------------------
// right-pane-controller — per-kind dispatch, in-place right-pane swap.
// ---------------------------------------------------------------------------
//
// The steps-view daemon sends user intents (`enter`, `follow-live`, `quit`)
// into this controller. On Enter the controller looks up the selected step on
// disk via `StateStore.loadRun`, renders the per-kind replay payload to a
// file under `<stateDir>/.replay/<stepName>.txt`, then issues
// `tmux respawn-pane -k -t <rightPaneId> -- cat <file>`. The single right
// pane swaps in place — no new tmux windows, no window switch.
//
// `cat <file>` writes via the new process's stdout (not stdin), which means
// pty-echo doubling that bites `sendKeys` for replay-sized payloads is
// irrelevant here. `remain-on-exit on` (set in session-init) keeps the dead
// pane visible after `cat` exits.
//
// On `follow-live`, the controller respawns the pane back to the `cat`
// placeholder so the next live runner has a known-good target. On Enter
// while a step is mid-flight, the controller refuses with a footer message
// so the live transcript isn't blown away.

import { mkdir, writeFile } from 'node:fs/promises'
import { orchLog, type SessionLogger } from '../../observability/index.ts'
import type { Runner } from '../../runners/index.ts'
import type { PaneId, SocketName, TmuxService } from '../../services/tmux/index.ts'
import { type Path, path as toPath } from '../../services/types.ts'
import type { RunId, StateStore, StepEntry } from '../../state/index.ts'
import { renderKindDetails } from './kind-details.tsx'
import type { PaneQueue } from './pane-queue.ts'
import { resolveCommandPaneSource } from './replay-command-pane.ts'
import { renderTranscriptToString } from './replay-transcript.ts'
import { projectStepsView, type StepRow, type StepsIntent } from './steps-view/index.ts'

const PLACEHOLDER_CMD = 'cat'

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
   * Optional renderer for autonomous-agent transcripts. Defaults to a
   * JSON-fallback renderer in `replay-transcript.ts`. Tests / Phase 4 demo
   * pass the workflow's primary runner's `toTranscriptLines`.
   */
  readonly transcriptRenderer?: Runner['toTranscriptLines']
  /**
   * Phase 3 resume launcher. When provided, agent-interactive Enter calls
   * `resumeRunner.resumeCommand(ctx, sessionId)` and respawns the right
   * pane with the resulting argv. Without it, agent-interactive Enter shows
   * the "this runner doesn't support resume" footer message.
   */
  readonly resumeRunner?: Runner
  /**
   * Busy gate. The host flips this true while a step is mid-flight on the
   * right pane (autonomous transcript flowing OR interactive agent live).
   * Enter is refused with a footer message + `replay-blocked-busy` log when
   * the gate returns true.
   */
  readonly isRightPaneBusy?: () => boolean
}

export interface RightPaneController {
  /** Wire this into `startStepsView`'s `onIntent`. */
  onIntent(intent: StepsIntent): void
  /** Tear down: drop references and stop accepting intents. */
  stop(): Promise<void>
}

export function createRightPaneController(opts: RightPaneControllerOptions): RightPaneController {
  let stopped = false
  let priorEnterFired = false

  const closeReplay = async (): Promise<void> => {
    if (!priorEnterFired) return
    priorEnterFired = false
    void opts.logger?.append('lifecycle', { type: 'replay-pane-closing' }).catch(() => {})
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
      void opts.logger
        ?.append('lifecycle', {
          type: 'replay-pane-close-failed',
          error: String(err),
        })
        .catch(() => {})
    }
  }

  const lookupStep = async (stepName: string): Promise<StepRow | undefined> => {
    const run = await opts.stateStore.loadRun(opts.runId)
    const entry: StepEntry | undefined = run?.steps[stepName]
    // Project a single-step view so the StepRow shape matches what the
    // dispatch functions consume. We don't need the run-level header here.
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
      void opts.logger
        ?.append('lifecycle', { type: 'replay-blocked-busy', stepName })
        .catch(() => {})
      await writeBusyFooter(stepName)
      return
    }

    const step = await lookupStep(stepName)
    if (step === undefined) {
      // Currently fails silently — no respawn, no error visible. Log so the
      // operator can see WHY Enter "did nothing" for a given step.
      void opts.logger
        ?.append('lifecycle', { type: 'replay-lookup-miss', stepName })
        .catch(() => {})
      return
    }

    try {
      await dispatchByKind(opts, step)
      priorEnterFired = true
      void opts.logger
        ?.append('lifecycle', {
          type: 'replay-pane-opened',
          stepName,
          paneId: String(opts.rightPaneId),
        })
        .catch(() => {})
      orchLog(opts.logger, 'replay-kind-dispatched', { stepName, kind: step.kind })
    } catch (err) {
      opts.stderr.write(`[orch tui] replay dispatch failed: ${String(err)}\n`)
      void opts.logger
        ?.append('lifecycle', {
          type: 'replay-pane-failed',
          stepName,
          error: String(err),
        })
        .catch(() => {})
    }
  }

  const onIntent = (intent: StepsIntent): void => {
    if (stopped) return
    // Always-on: pairs with `start-steps-view`'s `tui-intent` entry, so a
    // stalled controller is distinguishable from an unread intent file.
    void opts.logger?.append('lifecycle', { type: 'replay-intent', intent }).catch(() => {})
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

  return { onIntent, stop }
}

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
    // Phase 2 has no field on the row that says whether the command was
    // silent — we infer it from log presence: if the pane log file is
    // missing or empty, render the no-capture placeholder.
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
  // Sanitize step names that might contain `/`, `:`, etc. into a single
  // filesystem-safe filename. Same character class as the old replay window
  // name helper.
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
  // Single closure: file write + respawn-pane atomic per-pane. Other Enters
  // can't interleave their respawn between our write and our cat; live
  // runner writes can't either (they enqueue on the same pane).
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

/**
 * Returns a refusal message when resume cannot be launched, or `undefined`
 * when every prerequisite (runner, resumeCommand, sessionId) is satisfied.
 * Single source of truth for the "this runner doesn't support resume" copy
 * — controller / tests / future single-pane share one phrasing.
 */
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
  // Capability checks above guarantee resumeRunner + resumeCommand + sessionId.
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
