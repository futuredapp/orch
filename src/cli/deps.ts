import { createFileSessionLogger, type SessionLogger } from '../observability/index.ts'
import type { Clock, FsService, GitService, ProcessService } from '../services/index.ts'
import {
  BunClock,
  BunFsService,
  BunGitService,
  BunProcessService,
  path,
} from '../services/index.ts'
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
  }
}
