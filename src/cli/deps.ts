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
import type { PromptService } from '../services/prompt/index.ts'
import { InkPromptService, ReadlinePromptService } from '../services/prompt/index.ts'
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
  const basePath = path(`${cwdPath}/.orch/state`)
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
