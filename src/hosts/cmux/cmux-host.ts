import type { StepName } from '../../core/types.ts'
import type { StepLifecycleEvent } from '../../core/workflow.ts'
import { orchLog, type SessionLogger } from '../../observability/index.ts'
import type { Clock } from '../../services/clock/index.ts'
import { mergeEnv, type Path } from '../../services/index.ts'
import type { ProcessService } from '../../services/process/index.ts'
import type {
  CommandLine,
  ForegroundShutdownReason,
  Host,
  HostReachability,
  InteractiveResult,
  InteractiveSpawn,
  PaneAttachment,
  PaneRole,
} from '../host.ts'

export interface CmuxHostOptions {
  readonly processService: ProcessService
  readonly clock: Clock
  readonly workflowName: string
  readonly cmuxConfig?: { readonly enabled?: boolean }
  /**
   * process.env slice — used to check CMUX_SURFACE_ID and, via `mergeEnv`, to
   * give the `cmux` subprocesses a PATH so the binary actually resolves.
   */
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly cwd: Path
  /** Per-run session logger. Records the gate outcome and (with --debug) spawns. */
  readonly logger?: SessionLogger
}

/**
 * Extended Host returned by `createCmuxHost`. `notifyRunEnd` is called from
 * `beforeTeardown` to fire the run-end notification and clear sidebar pills.
 * `flush` resolves when all in-flight cmux spawns have settled — for unit
 * tests only.
 */
export type CmuxHost = Host & {
  notifyRunEnd(exitCode: number): Promise<void>
  /** Unit-test-only: await all in-flight cmux spawns. */
  flush(): Promise<void>
}

const PILL_KEYS = ['orch_workflow', 'orch_step', 'orch_runner', 'orch_mode'] as const

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Three-gate factory:
 *  1. CMUX_SURFACE_ID absent → no-op (zero cmux calls, zero probe)
 *  2. cmux.enabled === false → no-op
 *  3. `cmux ping` non-zero → no-op
 * Otherwise returns the live CmuxHost.
 */
export async function createCmuxHost(opts: CmuxHostOptions): Promise<CmuxHost> {
  if (!opts.env?.CMUX_SURFACE_ID) {
    logGateOutcome(opts.logger, 'disabled-no-surface-id')
    return createNoOpCmuxHost()
  }

  if (opts.cmuxConfig?.enabled === false) {
    logGateOutcome(opts.logger, 'disabled-config')
    return createNoOpCmuxHost()
  }

  if (!(await probeCmux(opts))) {
    logGateOutcome(opts.logger, 'disabled-ping-failed')
    return createNoOpCmuxHost()
  }

  logGateOutcome(opts.logger, 'active')
  return createLiveCmuxHost(opts)
}

type CmuxGateOutcome =
  | 'disabled-no-surface-id'
  | 'disabled-config'
  | 'disabled-ping-failed'
  | 'active'

/**
 * One always-on lifecycle line per run, recording whether cmux activated and —
 * when it didn't — why. This is the first thing to grep when "cmux is quiet":
 * it lands in `lifecycle.ndjson` with no `--debug` required. Errors swallowed
 * per R15.
 */
function logGateOutcome(logger: SessionLogger | undefined, outcome: CmuxGateOutcome): void {
  void logger?.append('lifecycle', { type: 'cmux-host', outcome }).catch(() => {})
}

// ---------------------------------------------------------------------------
// Spawn helper (module-level, shared by probe and live host)
// ---------------------------------------------------------------------------

/**
 * Spawns a cmux sub-command and drains its output. Errors are NOT swallowed
 * here — callers decide whether to swallow (live host wraps calls in
 * try/catch; probe uses the return value).
 *
 * `env` MUST carry a PATH (built via `mergeEnv` at the call site) — the real
 * ProcessService treats `env` as a full replacement, so a bare `{}` leaves the
 * spawned process with no PATH and `cmux` fails to resolve (ENOENT).
 */
async function spawnCmux(
  processService: ProcessService,
  cwd: Path,
  env: Readonly<Record<string, string>>,
  argv: readonly string[],
): Promise<{ exitCode: number }> {
  const handle = processService.spawn({ argv, cwd, env })
  // Drain stdout so FakeProcessService's iterationPromise resolves and
  // real processes don't back-pressure on a full pipe.
  for await (const _ of handle.stdout) {
  }
  return handle.wait()
}

/** Subprocess env for cmux — passthrough so `cmux` resolves on PATH. */
function cmuxEnv(opts: CmuxHostOptions): Record<string, string> {
  return mergeEnv(opts.env ?? {}, {}, {})
}

// ---------------------------------------------------------------------------
// Availability probe
// ---------------------------------------------------------------------------

async function probeCmux(opts: CmuxHostOptions): Promise<boolean> {
  const argv = ['cmux', 'ping'] as const
  try {
    const { exitCode } = await spawnCmux(opts.processService, opts.cwd, cmuxEnv(opts), argv)
    orchLog(opts.logger, 'cmux-spawn', { argv: [...argv], exitCode })
    return exitCode === 0
  } catch (err) {
    orchLog(opts.logger, 'cmux-spawn-error', { argv: [...argv], error: stringifyError(err) })
    return false
  }
}

// ---------------------------------------------------------------------------
// No-op host (returned when probe fails or integration is disabled)
// ---------------------------------------------------------------------------

function createNoOpCmuxHost(): CmuxHost {
  return {
    get mode() {
      return 'plain' as const
    },
    writeBanner(_line: string): void {},
    onRunnerEvent(): void {},
    onLifecycleEvent(_event: StepLifecycleEvent): void {},
    onCommandLine(_spec: CommandLine): void {},
    async attach(pane: PaneRole): Promise<PaneAttachment> {
      return { pane, async detach() {} }
    },
    async runInteractive(_opts: InteractiveSpawn): Promise<InteractiveResult> {
      return { exitCode: 0, durationMs: 0 }
    },
    async attachForeground(): Promise<void> {},
    async awaitForegroundShutdown(): Promise<ForegroundShutdownReason> {
      return 'attach-exited'
    },
    async probeReachability(): Promise<HostReachability> {
      return { reachable: true }
    },
    async teardown(): Promise<void> {},
    async notifyRunEnd(_exitCode: number): Promise<void> {},
    async flush(): Promise<void> {},
  }
}

// ---------------------------------------------------------------------------
// Live host
// ---------------------------------------------------------------------------

// Exceeds 60-line function guideline: this factory is a single cohesive unit
// whose closure state (stepIndex, lastFailedStep, runStartMs, chain) cannot be
// split without introducing unnecessary indirection or shared mutable state.
function createLiveCmuxHost(opts: CmuxHostOptions): CmuxHost {
  let stepIndex = 0
  let lastFailedStep: StepName | undefined
  let runStartMs: number | undefined
  let runEndFired = false
  let chain: Promise<void> = Promise.resolve()

  function enqueue(work: () => Promise<void>): void {
    chain = chain.then(work).catch(() => {})
  }

  const spawnEnv = cmuxEnv(opts)

  async function fireSpawnCmux(argv: readonly string[]): Promise<void> {
    try {
      const { exitCode } = await spawnCmux(opts.processService, opts.cwd, spawnEnv, argv)
      orchLog(opts.logger, 'cmux-spawn', { argv: [...argv], exitCode })
    } catch (err) {
      // swallowed per R15: cmux errors must never propagate into the run
      orchLog(opts.logger, 'cmux-spawn-error', { argv: [...argv], error: stringifyError(err) })
    }
  }

  /**
   * Fire the run-end side effects (completion/failure notify + clear all
   * sidebar pills) exactly once per run. Enqueued on `chain` so it lands after
   * the last step's pill updates. Guarded by `runEndFired` so the two callers —
   * the `run:ended` lifecycle event (fires when the workflow settles) and
   * `notifyRunEnd` (the teardown backstop for abort/signal paths where no
   * `run:ended` is emitted) — never double-fire.
   */
  function fireRunEnd(success: boolean): void {
    if (runEndFired) {
      return
    }
    runEndFired = true

    enqueue(async () => {
      const startMs = runStartMs ?? opts.clock.now()
      const durationMs = opts.clock.now() - startMs

      if (success) {
        await fireSpawnCmux([
          'cmux',
          'notify',
          '--title',
          `orch · ${opts.workflowName}`,
          '--body',
          `✅ completed in ${formatDuration(durationMs)}`,
        ])
      } else {
        const body =
          lastFailedStep !== undefined ? `❌ failed at step '${lastFailedStep}'` : '❌ run failed'
        await fireSpawnCmux([
          'cmux',
          'notify',
          '--title',
          `orch · ${opts.workflowName}`,
          '--body',
          body,
        ])
      }

      await Promise.all(PILL_KEYS.map((key) => fireSpawnCmux(['cmux', 'clear-status', key])))
    })
  }

  function onLifecycleEvent(event: StepLifecycleEvent): void {
    if (event.type === 'run:ended') {
      fireRunEnd(event.status === 'completed')
      return
    }
    if (event.type === 'step:start') {
      if (runStartMs === undefined) {
        runStartMs = opts.clock.now()
      }
      stepIndex += 1
      const { stepName, mode } = event
      const runnerName = event.runnerName ?? ''
      const currentIndex = stepIndex
      const modeLabel = mode === 'autonomous' ? 'auto' : 'interactive'

      enqueue(async () => {
        await Promise.all([
          fireSpawnCmux(['cmux', 'set-status', 'orch_workflow', opts.workflowName]),
          fireSpawnCmux(['cmux', 'set-status', 'orch_step', `${stepName} · ${currentIndex}`]),
          fireSpawnCmux(['cmux', 'set-status', 'orch_runner', runnerName]),
          fireSpawnCmux(['cmux', 'set-status', 'orch_mode', modeLabel]),
        ])
        if (mode === 'interactive') {
          await fireSpawnCmux([
            'cmux',
            'notify',
            '--title',
            `orch · ${opts.workflowName}`,
            '--body',
            `⏸ step '${stepName}' needs you`,
          ])
        }
      })
    } else if (event.type === 'step:failed') {
      lastFailedStep = event.stepName
    }
  }

  async function notifyRunEnd(exitCode: number): Promise<void> {
    // Teardown backstop. On the normal paths the `run:ended` lifecycle event
    // already fired `fireRunEnd` when the workflow settled, so this is a guarded
    // no-op that only awaits the chain. It still does the real work on the
    // abort/signal paths (user quits mid-step, host loss) where the workflow
    // never settled and no `run:ended` event was emitted.
    fireRunEnd(exitCode === 0)
    await chain
  }

  return {
    get mode() {
      return 'plain' as const
    },
    writeBanner(_line: string): void {},
    onRunnerEvent(): void {},
    onLifecycleEvent,
    onCommandLine(_spec: CommandLine): void {},
    async attach(pane: PaneRole): Promise<PaneAttachment> {
      return { pane, async detach() {} }
    },
    async runInteractive(_opts: InteractiveSpawn): Promise<InteractiveResult> {
      return { exitCode: 0, durationMs: 0 }
    },
    async attachForeground(): Promise<void> {},
    async awaitForegroundShutdown(): Promise<ForegroundShutdownReason> {
      return 'attach-exited'
    },
    async probeReachability(): Promise<HostReachability> {
      return { reachable: true }
    },
    async teardown(): Promise<void> {},
    notifyRunEnd,
    async flush(): Promise<void> {
      await chain
    },
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stringifyError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSec / 60)
  const seconds = totalSec % 60
  return `${minutes}m${seconds}s`
}
