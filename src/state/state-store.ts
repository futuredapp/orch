import type { FsService, Path } from '../services/index.ts'
import type { RunId } from './run-id.ts'

export interface StepEntry {
  readonly name: string
  readonly value: unknown
  readonly startedAt: number
  readonly endedAt: number
  readonly artifacts: readonly string[]
}

export interface RunState {
  readonly schemaVersion: 1
  readonly id: RunId
  readonly status: 'running' | 'completed' | 'crashed'
  readonly steps: Readonly<Record<string, StepEntry>>
}

export interface StateStore {
  loadRun(runId: RunId): Promise<RunState | undefined>
  saveStep(runId: RunId, entry: StepEntry): Promise<void>
}

export class StateCorruptionError extends Error {
  constructor(
    message: string,
    readonly path: Path,
    readonly zodIssues: readonly {
      readonly path: readonly (string | number)[]
      readonly message: string
    }[],
  ) {
    super(message)
    this.name = 'StateCorruptionError'
  }
}

export class FileStateStore implements StateStore {
  constructor(_deps: { readonly fs: FsService; readonly basePath: Path }) {
    throw new Error('Not implemented')
  }

  loadRun(_runId: RunId): Promise<RunState | undefined> {
    throw new Error('Not implemented')
  }

  saveStep(_runId: RunId, _entry: StepEntry): Promise<void> {
    throw new Error('Not implemented')
  }
}
