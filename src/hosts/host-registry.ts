// ---------------------------------------------------------------------------
// HostRegistry — `RunMode` → `Host` factory table.
// ---------------------------------------------------------------------------
//
// The CLI today picks a host with a switch on `resolution.mode` in
// `src/cli/main.ts`. This registry is the same shape, hoisted so v2 plugins
// (wezterm, zellij, kitty) can register alternative hosts from outside the
// CLI without patching main.ts.
//
// No import-time side effects (CLAUDE.md rule #8). Built-in registration
// happens in the composition root via `registerBuiltinHosts(registry, deps)`.

import type { RunMode } from '../core/run-mode.ts'
import { SINGLE_PANE_DEFERRED_MESSAGE } from '../core/run-mode.ts'
import type { ProcessService } from '../services/process/index.ts'
import { type SocketName, socketName } from '../services/tmux/index.ts'
import type { Host } from './host.ts'
import type { PlainFormat } from './plain/plain-host.ts'
import { createPlainHost } from './plain/plain-host.ts'
import type { TmuxHostOptions } from './two-pane/index.ts'
import { createTmuxHost } from './two-pane/index.ts'

export class HostResolutionError extends Error {
  readonly code = 'HOST_RESOLUTION' as const
  constructor(message: string) {
    super(message)
    this.name = 'HostResolutionError'
  }
}

/** Per-invocation input the CLI hands a host factory. */
export interface HostFactoryInputs {
  readonly runId: import('../state/run-id.ts').RunId
  readonly workflowName: string
  readonly stdout: NodeJS.WritableStream
  readonly stderr: NodeJS.WritableStream
  readonly clock: import('../services/clock/index.ts').Clock
  /** Per-run session logger. Forwarded to hosts that emit lifecycle records. */
  readonly logger?: import('../observability/session-logger.ts').SessionLogger
  /**
   * Per-run ProcessService override. Lets the CLI hand in a logger-wrapped
   * service (see `instrumentProcessService`) so tmux subprocess spawns land
   * in `subprocesses.ndjson` under `--debug`. Falls back to the registry's
   * service when absent.
   */
  readonly processService?: ProcessService
  /**
   * Optional FsService — required by the two-pane host under `--debug` to
   * create the `logs/tmux/` directory for pipe-pane captures. Tests and
   * baseline (non-debug) runs can safely omit it.
   */
  readonly fs?: import('../services/fs/index.ts').FsService
  /**
   * Optional StateStore — required by the two-pane host's right-pane
   * controller (Enter-to-inspect dispatch). Without it, intents from the
   * Ink steps-view are received and logged but never trigger a replay
   * window. The CLI threads in `deps.stateStore` for `run` / `resume`.
   */
  readonly stateStore?: import('../state/index.ts').StateStore
  /**
   * Live runner registry shared with the workflow executor. The CLI creates
   * one instance and threads the same reference here AND into `WorkflowDeps`,
   * so the right-pane controller can resolve a runner by step name on Enter
   * while the executor populates the registry from `runStepOnce`. Optional —
   * tests that exercise the "no runner wired" refusal path omit it.
   */
  readonly resumeRegistry?: import('../core/resume-registry.ts').ResumeRegistry
}

export type HostFactory = (inputs: HostFactoryInputs) => Promise<Host>

export interface HostRegistry {
  register(mode: RunMode, factory: HostFactory): void
  resolve(mode: RunMode): HostFactory
  list(): readonly RunMode[]
}

export function createHostRegistry(): HostRegistry {
  const table = new Map<RunMode, HostFactory>()
  return {
    register(mode, factory) {
      if (table.has(mode)) {
        throw new HostResolutionError(`host for mode "${mode}" is already registered`)
      }
      table.set(mode, factory)
    },
    resolve(mode) {
      const factory = table.get(mode)
      if (factory === undefined) {
        throw new HostResolutionError(`no host registered for mode "${mode}"`)
      }
      return factory
    },
    list() {
      return [...table.keys()]
    },
  }
}

export interface RegisterBuiltinHostsDeps {
  readonly processService: ProcessService
  readonly format: PlainFormat
  /** Overrides handed to `createTmuxHost` beyond the per-invocation args. */
  readonly tmuxOverrides?: Omit<
    TmuxHostOptions,
    'processService' | 'clock' | 'runId' | 'workflowName' | 'stderr'
  >
}

/**
 * Registers `plain`, `single-pane` (stub — exits 2 with deferral), and
 * `two-pane`. The CLI calls this once, then resolves the mode's factory
 * at dispatch time.
 */
export function registerBuiltinHosts(registry: HostRegistry, deps: RegisterBuiltinHostsDeps): void {
  registry.register('plain', async (args) =>
    createPlainHost({
      stdout: args.stdout,
      stderr: args.stderr,
      format: deps.format,
      clock: args.clock,
      runId: args.runId,
      processService: args.processService ?? deps.processService,
      ...(args.logger !== undefined ? { logger: args.logger } : {}),
    }),
  )

  registry.register('single-pane', async () => {
    throw new HostResolutionError(SINGLE_PANE_DEFERRED_MESSAGE)
  })

  registry.register('two-pane', (args) =>
    createTmuxHost({
      processService: args.processService ?? deps.processService,
      clock: args.clock,
      runId: args.runId,
      workflowName: args.workflowName,
      stderr: args.stderr,
      ...(deps.tmuxOverrides ?? {}),
      // Env bridge spreads last: ORCH_TMUX_SOCKET wins over any `socket` set in
      // `tmuxOverrides` (the subprocess bridge must win — see readTmuxSocketOverride).
      ...readTmuxSocketOverride(),
      ...(args.logger !== undefined ? { logger: args.logger } : {}),
      ...(args.fs !== undefined ? { fs: args.fs } : {}),
      ...(args.stateStore !== undefined ? { stateStore: args.stateStore } : {}),
      ...(args.resumeRegistry !== undefined ? { resumeRegistry: args.resumeRegistry } : {}),
    }),
  )
}

/**
 * Test-only out-of-process socket bridge (KTD-3). The real-tmux behavioral-dsl
 * harness spawns `orch` as a subprocess and cannot hand it a TypeScript param,
 * so it passes `ORCH_TMUX_SOCKET=orch-test-<pid>-<nonce>` in the child's env.
 * Read here at host-build time (never at import — CLAUDE.md rule #8) and threaded
 * into `createTmuxHost`'s `socket` param so the spawned run's tmux server lands
 * in the reserved namespace and its leaks are reapable by the stale-socket
 * preload.
 *
 * Unset/empty/whitespace-only → byte-for-byte unchanged production behavior
 * (`orch-${runId}`). A non-empty but malformed value fails loudly through the
 * `socketName` smart constructor rather than booting an out-of-grammar server.
 */
function readTmuxSocketOverride(): { readonly socket: SocketName } | Record<string, never> {
  const raw = process.env.ORCH_TMUX_SOCKET
  if (raw === undefined || raw.trim().length === 0) return {}
  return { socket: socketName(raw) }
}
