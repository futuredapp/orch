import type { Clock, FsService, GitService, ProcessService } from '../services/index.ts'
import {
  BunClock,
  BunFsService,
  BunGitService,
  BunProcessService,
  path,
} from '../services/index.ts'
import type { Path } from '../services/types.ts'
import type { RunRegistry, StateStore } from '../state/index.ts'
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
}

// ---------------------------------------------------------------------------
// createDeps — hardcoded composition root, wires real services
// ---------------------------------------------------------------------------

export function createDeps(cwd: string): CliDeps {
  const cwdPath = path(cwd)
  const basePath = path(`${cwdPath}/.orch/state`)
  const fs = new BunFsService()
  const processService = new BunProcessService()
  return {
    processService,
    fsService: fs,
    gitService: new BunGitService({ processService }),
    clock: new BunClock(),
    stateStore: new FileStateStore({ fs, basePath }),
    registry: new FileRunRegistry({ fs, basePath }),
    cwd: cwdPath,
  }
}
