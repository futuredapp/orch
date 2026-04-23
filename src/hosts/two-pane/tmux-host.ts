// ---------------------------------------------------------------------------
// TmuxHost — the `--mode=two-pane` implementation of the Host port.
// ---------------------------------------------------------------------------
//
// Two panes: left runs a `cat` placeholder with the status rollup drawn into
// it; right runs a `cat` placeholder that receives transcript lines (for
// autonomous steps) or is respawned with the runner argv (for interactive
// steps). The placeholders matter — `send-keys -l` writes bytes to the pane's
// stdin, so if the pane ran a shell, every transcript line would be shell
// input. `cat` just echoes; any future swap of the placeholder must be a
// non-interpreting process (see tmux-service's respawn-pane contract).
//
// Every pane write goes through the shared PaneQueue — transcript fan-out,
// status rollup, and respawn-pane -k all serialize per pane so a pending
// transcript keystroke can never land on an interactive process that just
// took the pane over.

import type { RunMode } from '../../core/run-mode.ts'
import type { RunId, StepName } from '../../core/types.ts'
import type { StepLifecycleEvent } from '../../core/workflow.ts'
import { type StatusLoop, startStatusLoop } from '../../observability/index.ts'
import type { RunnerEvent } from '../../runners/index.ts'
import type { Clock } from '../../services/clock/index.ts'
import type { ProcessService } from '../../services/process/index.ts'
import type { PaneId, SocketName, TmuxService } from '../../services/tmux/index.ts'
import { initOrchSession, paneId, RealTmuxService, socketName } from '../../services/tmux/index.ts'
import type {
  Host,
  InteractiveResult,
  InteractiveSpawn,
  PaneAttachment,
  PaneRole,
} from '../host.ts'
import { renderTranscriptLine } from '../plain/transcript-text.ts'
import { createPaneQueue, type PaneQueue } from './pane-queue.ts'

// Defaults mirror the old `src/cli/tmux-wiring.ts`. Kept in-file because they
// are pane-geometry choices, not user-facing config; a v2 layout-tree surface
// would replace them.
const SESSION = 'orch'
const WIDTH = 200
const HEIGHT = 50
const RIGHT_PERCENT = 70
const PLACEHOLDER_CMD = 'cat'
// Global pane-died hook that `initOrchSession` wires — fires once per pane
// death and signals a per-pane `wait-for` channel so interactive runs can
// detect their child's exit deterministically.
const PANE_DIED_COMMAND = 'run-shell "tmux wait-for -S pane-exit-#{hook_pane}"'
// Interactive-step wait cap. Long enough for a real review session, short
// enough that a zombie pane-exit hook doesn't hang orch forever.
const INTERACTIVE_WAIT_TIMEOUT_MS = 3_600_000

export interface TmuxHostOptions {
  readonly tmux?: TmuxService
  readonly processService: ProcessService
  readonly clock: Clock
  readonly runId: RunId
  readonly workflowName: string
  readonly stderr: NodeJS.WritableStream
  /** Skip the `tmux -V` probe. Tests using FakeTmuxService set this `true`. */
  readonly skipVersionCheck?: boolean
}

export async function createTmuxHost(opts: TmuxHostOptions): Promise<Host> {
  const tmux: TmuxService =
    opts.tmux ?? new RealTmuxService({ processService: opts.processService })
  const socket = socketName(`orch-${opts.runId}`)
  const queue = createPaneQueue()

  await initOrchSession(tmux, {
    socket,
    session: SESSION,
    width: WIDTH,
    height: HEIGHT,
    paneDiedCommand: PANE_DIED_COMMAND,
  })

  // Left pane is the session's initial pane. Swap the default shell for `cat`
  // so the status loop's sendKeys draws to a clean pty (no PS1 pollution).
  const initialPanes = await tmux.listPanes({
    socket,
    session: SESSION,
    format: '#{pane_id}',
  })
  const firstPane = initialPanes[0]
  if (firstPane === undefined) {
    throw new Error('TmuxHost: tmux new-session produced no panes')
  }
  const leftPaneId = paneId(firstPane)

  // `clear && exec cat` — wipe any prior output, replace the shell with `cat`
  // so sendKeys bytes never reach a shell interpreter.
  await queue.enqueue(leftPaneId, () =>
    tmux.sendKeys({
      socket,
      target: leftPaneId,
      keys: ['clear && exec cat'],
      enter: true,
    }),
  )

  const rightPaneId = await tmux.splitPane({
    socket,
    session: SESSION,
    orientation: 'h',
    percent: RIGHT_PERCENT,
    command: PLACEHOLDER_CMD,
  })

  const statusLoop: StatusLoop = startStatusLoop({
    tmux,
    socket,
    target: leftPaneId,
    clock: opts.clock,
    runTitle: opts.workflowName,
    onError: (err) => opts.stderr.write(`[orch tmux] ${String(err)}\n`),
  })

  opts.stderr.write(
    `[orch tmux] attach with:   tmux -L ${socket} attach -t ${SESSION}\n` +
      `[orch tmux] clean up with: tmux -L ${socket} kill-server\n`,
  )

  return buildHost({
    tmux,
    socket,
    queue,
    leftPaneId,
    rightPaneId,
    statusLoop,
    stderr: opts.stderr,
    clock: opts.clock,
  })
}

interface BuildHostDeps {
  readonly tmux: TmuxService
  readonly socket: SocketName
  readonly queue: PaneQueue
  readonly leftPaneId: PaneId
  readonly rightPaneId: PaneId
  readonly statusLoop: StatusLoop
  readonly stderr: NodeJS.WritableStream
  readonly clock: Clock
}

function buildHost(deps: BuildHostDeps): Host {
  const mode: RunMode = 'two-pane'
  let torndown = false

  const handleSendError = (err: unknown): void => {
    if (torndown) return
    deps.stderr.write(`[orch tmux] ${String(err)}\n`)
  }

  const writeBanner = (line: string): void => {
    deps.stderr.write(`${line}\n`)
  }

  const onLifecycleEvent = (event: StepLifecycleEvent): void => {
    deps.statusLoop.onStepEvent(event)
  }

  const onRunnerEvent = (event: RunnerEvent, step: StepName): void => {
    if (torndown) return
    const line = renderTranscriptLine(event)
    if (line === null) return
    // Never write raw JSON — the transcript is what humans see via tmux.
    // Step prefix mirrors the `[step] …` shape the plain host uses.
    const payload = `[${step}] ${line}\r\n`
    void deps.queue
      .enqueue(deps.rightPaneId, () =>
        deps.tmux.sendKeys({
          socket: deps.socket,
          target: deps.rightPaneId,
          keys: [payload],
        }),
      )
      .catch(handleSendError)
  }

  const attach = async (pane: PaneRole): Promise<PaneAttachment> => ({
    pane,
    async detach(): Promise<void> {
      /* current v1 host does not swap views on detach — interactive path
         owns respawn directly via runInteractive(). Kept as a no-op so the
         Host contract is uniform across modes. */
    },
  })

  const runInteractive = async (spawn: InteractiveSpawn): Promise<InteractiveResult> => {
    const startedAt = deps.clock.now()

    // respawn-pane enqueues behind any pending sendKeys on the right pane so
    // no transcript keystroke races the interactive child's stdin.
    await deps.queue.enqueue(deps.rightPaneId, () =>
      deps.tmux.respawnPane({
        socket: deps.socket,
        target: deps.rightPaneId,
        argv: spawn.argv,
        killRunning: true,
      }),
    )

    // The global `pane-died` hook (installed by `initOrchSession`) signals
    // `pane-exit-<paneId>` when the child exits. We race against a hard cap
    // so a zombie hook never hangs orch forever — see tmux issue #2679.
    try {
      await deps.tmux.waitFor({
        socket: deps.socket,
        channel: `pane-exit-${deps.rightPaneId}`,
        timeoutMs: INTERACTIVE_WAIT_TIMEOUT_MS,
      })
    } finally {
      // Restore the `cat` placeholder so the next autonomous step's
      // transcript has a pane to write to.
      await deps.queue
        .enqueue(deps.rightPaneId, () =>
          deps.tmux.respawnPane({
            socket: deps.socket,
            target: deps.rightPaneId,
            argv: [PLACEHOLDER_CMD],
            killRunning: true,
          }),
        )
        .catch(handleSendError)
    }

    // tmux's `pane-died` hook doesn't give us the child's exit code through
    // the wait-for channel. The interactive pane is best-effort; we treat a
    // clean exit as exit 0. Phase D2 will wire structured failure capture.
    return { exitCode: 0, durationMs: deps.clock.now() - startedAt }
  }

  const teardown = async (): Promise<void> => {
    if (torndown) return
    torndown = true
    deps.statusLoop.stop()
    await deps.queue.drain()
  }

  return { mode, writeBanner, onRunnerEvent, onLifecycleEvent, attach, runInteractive, teardown }
}
