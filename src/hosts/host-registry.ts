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
      processService: deps.processService,
    }),
  )

  registry.register('single-pane', async () => {
    throw new HostResolutionError(SINGLE_PANE_DEFERRED_MESSAGE)
  })

  registry.register('two-pane', (args) =>
    createTmuxHost({
      processService: deps.processService,
      clock: args.clock,
      runId: args.runId,
      workflowName: args.workflowName,
      stderr: args.stderr,
      ...(deps.tmuxOverrides ?? {}),
    }),
  )
}
