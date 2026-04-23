// ---------------------------------------------------------------------------
// tmux-wiring — composes the Phase 13b/13c building blocks into a single
// entry point the CLI can call when `--tmux` / `--observe` is set.
// ---------------------------------------------------------------------------
//
// Flow when the CLI passes `tmux: true`:
//
//   1. Probe `tmux -V`; refuse if missing or < 3.2.
//   2. Socket = `orch-<runId>` (runId already matches SocketName brand).
//   3. `initOrchSession` creates a detached session with the lifecycle hooks.
//   4. `listPanes` finds the initial shell pane; replace it with `exec cat`
//      so the status loop can draw to a clean pty (no PS1 pollution).
//   5. If `observe`: split a right pane running `cat` for the runner-event feed.
//   6. `startStatusLoop` — `onStepEvent` hook wired here.
//   7. Print the attach command to stderr so the user can `tmux attach`.
//
// On teardown the status loop is stopped; the tmux session stays alive so
// failures can be inspected (honours `remain-on-exit failed`). The printed
// kill hint shows how to clean up.

import type { StepLifecycleEvent } from '../core/workflow.ts'
import { startStatusLoop } from '../observability/index.ts'
import type { RunnerEvent } from '../runners/index.ts'
import type { Clock } from '../services/clock/index.ts'
import type { ProcessService } from '../services/process/index.ts'
import type { PaneId, SocketName, TmuxService } from '../services/tmux/index.ts'
import { initOrchSession, paneId, RealTmuxService, socketName } from '../services/tmux/index.ts'
import type { RunId } from '../state/index.ts'
import { meetsMinimumTmuxVersion, probeTmuxVersion } from './detect-tmux.ts'
import { ArgvError } from './main.ts'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TmuxHandles {
  /** Wire into `WorkflowDeps.onStepEvent`. */
  readonly onStepEvent: (event: StepLifecycleEvent) => void
  /**
   * Wire into `WorkflowDeps.onEvent` when observe mode is on. Sends a compact
   * line per event into the right observe pane.
   */
  readonly onEvent?: (event: RunnerEvent) => void
  /** Socket name created for this run — for tests and status strings. */
  readonly socket: SocketName
  /** Stop the status loop. Called from the workflow's `finally` block. */
  readonly teardown: () => Promise<void>
}

export interface SetupTmuxOptions {
  readonly processService: ProcessService
  readonly clock: Clock
  readonly runId: RunId
  readonly workflowName: string
  readonly observe: boolean
  readonly stderr: NodeJS.WritableStream
  /**
   * Override the TmuxService used to talk to tmux. Tests inject
   * `FakeTmuxService`; production wiring leaves this undefined to get the
   * `RealTmuxService` over the shared `ProcessService`.
   */
  readonly tmuxService?: TmuxService
  /**
   * Skip the `tmux -V` probe. Tests that inject a fake `TmuxService` have no
   * real tmux binary to probe against.
   */
  readonly skipVersionCheck?: boolean
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const SESSION = 'orch'
const WIDTH = 200
const HEIGHT = 50
const OBSERVE_PERCENT = 70
const PANE_DIED_COMMAND = 'run-shell "tmux wait-for -S pane-exit-#{hook_pane}"'

// ---------------------------------------------------------------------------
// setupTmux
// ---------------------------------------------------------------------------

export async function setupTmux(opts: SetupTmuxOptions): Promise<TmuxHandles> {
  if (opts.skipVersionCheck !== true) {
    const info = await probeTmuxVersion(opts.processService)
    if (info === undefined) {
      throw new ArgvError('--tmux requires tmux in PATH, but none was found')
    }
    if (!meetsMinimumTmuxVersion(info)) {
      throw new ArgvError(`--tmux requires tmux >= 3.2, found ${info.raw}`)
    }
  }

  const socket = socketName(`orch-${opts.runId}`)
  const tmux: TmuxService =
    opts.tmuxService ?? new RealTmuxService({ processService: opts.processService })

  await initOrchSession(tmux, {
    socket,
    session: SESSION,
    width: WIDTH,
    height: HEIGHT,
    paneDiedCommand: PANE_DIED_COMMAND,
  })

  const initialPanes = await tmux.listPanes({
    socket,
    session: SESSION,
    format: '#{pane_id}',
  })
  const first = initialPanes[0]
  if (first === undefined) {
    throw new Error('setupTmux: tmux new-session produced no panes')
  }
  const statusPaneId = paneId(first)

  // Replace the default shell with `cat` so the status loop's sendKeys draws
  // to a clean pty. `exec` wipes the shell process in place so there is no
  // prompt to pollute the render.
  await tmux.sendKeys({
    socket,
    target: statusPaneId,
    keys: ['clear && exec cat'],
    enter: true,
  })

  let observePaneId: PaneId | undefined
  if (opts.observe) {
    observePaneId = await tmux.splitPane({
      socket,
      session: SESSION,
      orientation: 'h',
      percent: OBSERVE_PERCENT,
      command: 'cat',
    })
  }

  const loop = startStatusLoop({
    tmux,
    socket,
    target: statusPaneId,
    clock: opts.clock,
    runTitle: opts.workflowName,
    onError: (error) => {
      opts.stderr.write(`[orch tmux] ${String(error)}\n`)
    },
  })

  opts.stderr.write(
    `[orch tmux] attach with:   tmux -L ${socket} attach -t ${SESSION}\n` +
      `[orch tmux] clean up with: tmux -L ${socket} kill-server\n`,
  )

  const onEvent = observePaneId
    ? (evt: RunnerEvent) => {
        // Fire-and-forget — observe should never block the workflow.
        const payload = `${evt.kind}:${evt.type} ${JSON.stringify(evt)}\r\n`
        void tmux
          .sendKeys({
            socket,
            target: observePaneId as PaneId,
            keys: [payload],
          })
          .catch((err) => opts.stderr.write(`[orch tmux] ${String(err)}\n`))
      }
    : undefined

  return {
    onStepEvent: loop.onStepEvent,
    ...(onEvent !== undefined ? { onEvent } : {}),
    socket,
    teardown: async () => {
      loop.stop()
    },
  }
}

// ---------------------------------------------------------------------------
// maybeSetupTmux — shared helper for CLI command handlers.
// Returns handles (tmux active), `'argv-error'` (tmux probe failed — caller
// should exit with CONFIG_ERROR), or `undefined` (tmux flag not set).
// ---------------------------------------------------------------------------

export async function maybeSetupTmux(
  opts: SetupTmuxOptions & { readonly enabled: boolean },
): Promise<TmuxHandles | 'argv-error' | undefined> {
  if (!opts.enabled) return undefined
  try {
    return await setupTmux(opts)
  } catch (err) {
    if (err instanceof ArgvError) {
      opts.stderr.write(`${err.message}\n`)
      return 'argv-error'
    }
    throw err
  }
}

/**
 * Narrows `TmuxHandles` into the subset of `WorkflowDeps` fields that activate
 * the tmux layout (onStepEvent, optional onEvent, tmuxActive).
 */
export function tmuxDepsFromHandles(handles: TmuxHandles): {
  readonly onStepEvent: (event: StepLifecycleEvent) => void
  readonly onEvent?: (event: RunnerEvent) => void
  readonly tmuxActive: true
} {
  return {
    onStepEvent: handles.onStepEvent,
    tmuxActive: true,
    ...(handles.onEvent !== undefined ? { onEvent: handles.onEvent } : {}),
  }
}
