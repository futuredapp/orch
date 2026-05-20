import type { RunMode } from '../core/run-mode.ts'
import { createFileSessionLogger, type SessionLogger } from '../observability/index.ts'
import type { Clock, FsService, GitService, ProcessService } from '../services/index.ts'
import {
  BunClock,
  BunFsService,
  BunGitService,
  BunProcessService,
  path,
} from '../services/index.ts'
import type { ConfirmService, PromptService } from '../services/prompt/index.ts'
import {
  InkPromptService,
  ReadlineConfirmService,
  ReadlinePromptService,
} from '../services/prompt/index.ts'
import type { Path } from '../services/types.ts'
import type { RunId, RunRegistry, StateStore } from '../state/index.ts'
import { FileRunRegistry, FileStateStore } from '../state/index.ts'

// ---------------------------------------------------------------------------
// CliDeps — everything the CLI commands need, typed against abstract interfaces
// ---------------------------------------------------------------------------

export interface CliDeps {
  readonly processService: ProcessService
  readonly fsService: FsService
  readonly gitService: GitService
  readonly clock: Clock
  readonly stateStore: StateStore
  readonly registry: RunRegistry
  readonly cwd: Path
  /** `<cwd>/.orch/state` — exposed so per-run consumers (transcript sidecar,
   *  `orch logs`) can derive `<basePath>/<runId>` without re-reading config. */
  readonly statePath: Path
  /** `--debug` flag (also `ORCH_DEBUG=1`) — resolved once per CLI invocation.
   *  Exposed so command handlers can pass it into contexts that need it (run
   *  metadata, README generator, etc.) without re-parsing argv. */
  readonly debug: boolean
  /** Per-run SessionLogger factory. Command handlers call this once for the
   *  run's `runId` and own the resulting logger's lifetime (close in their
   *  finally block). Phase 2: file-backed adapter wired to `statePath`. */
  readonly sessionLoggerFor: (runId: RunId) => SessionLogger
  /**
   * Prompt-service factory keyed by run mode. Plain returns
   * `ReadlinePromptService`; two-pane returns `InkPromptService`
   * (spawn-Ink-child via `host.runInteractive`); single-pane stays deferred.
   */
  readonly promptServiceFor: (mode: RunMode) => PromptService
  /**
   * Yes/no confirmation port for config-free commands (`orch init`,
   * `orch new`). Separate from `promptService` because the workflow-step
   * prompt machinery (StepName, Host, fields/buttons) is overkill for a
   * binary opt-in. See `src/services/prompt/confirm-service.ts`.
   */
  readonly confirmService: ConfirmService
  /**
   * Whether stdin is attached to a TTY (`process.stdin.isTTY === true`).
   * Exposed on `CliDeps` so the F2 re-init guard (R9) can refuse to prompt
   * upfront — before `ReadlineConfirmService` would write anything to
   * stderr — and so tests can drive both branches without process-level
   * mocking.
   */
  readonly isStdinTty: boolean
}

// ---------------------------------------------------------------------------
// createDeps — hardcoded composition root, wires real services
// ---------------------------------------------------------------------------

export interface CreateDepsOptions {
  /** Resolved `--debug` flag. Defaults to false. */
  readonly debug?: boolean
}

export function createDeps(cwd: string, opts: CreateDepsOptions = {}): CliDeps {
  const cwdPath = path(cwd)
  // `ORCH_STATE_BASE` lets Tier 5 fixtures (and any other harness that needs
  // per-process state isolation) redirect the state base away from
  // `<cwd>/.orch/state`. Passthrough env policy: absent → default location;
  // present → use as the absolute state root. See
  // `tests/helpers/behavioral-dsl/` (Tier 5).
  const stateBaseEnv = process.env.ORCH_STATE_BASE
  const basePath =
    typeof stateBaseEnv === 'string' && stateBaseEnv.length > 0
      ? path(stateBaseEnv)
      : path(`${cwdPath}/.orch/state`)
  const fs = new BunFsService()
  const processService = new BunProcessService()
  const clock = new BunClock()
  const debug = opts.debug === true
  return {
    processService,
    fsService: fs,
    gitService: new BunGitService({ processService }),
    clock,
    stateStore: new FileStateStore({ fs, basePath }),
    registry: new FileRunRegistry({ fs, basePath }),
    cwd: cwdPath,
    statePath: basePath,
    debug,
    sessionLoggerFor: (runId: RunId) =>
      createFileSessionLogger({ fs, clock, runId, basePath, debug }),
    promptServiceFor: makePromptServiceFactory(fs),
    confirmService: new ReadlineConfirmService(),
    // `process.stdin.isTTY` is `undefined` when stdin is piped or detached,
    // so the explicit `=== true` is required.
    isStdinTty: process.stdin.isTTY === true,
  }
}

function makePromptServiceFactory(fs: FsService): (mode: RunMode) => PromptService {
  return (mode) => {
    if (mode === 'plain') return new ReadlinePromptService()
    if (mode === 'two-pane') return new InkPromptService({ fs })
    return new DeferredSinglePanePromptService(mode)
  }
}

/**
 * Stand-in for single-pane mode (deferred per the run-mode roadmap). Two-pane
 * runs that don't use `ask()` keep working; the moment a single-pane run hits
 * `ask()`, we surface a clear error rather than crash at construction.
 */
class DeferredSinglePanePromptService implements PromptService {
  constructor(private readonly mode: RunMode) {}
  async ask(): Promise<never> {
    throw new Error(
      `ask() under --mode=${this.mode} is not yet implemented; ` +
        'use --mode=plain, --mode=two-pane, or --noninteractive',
    )
  }
}
