import type { FsService, Path } from '../services/index.ts'
import type { RunId } from './run-id.ts'

export interface RunRegistry {
  listRuns(): Promise<readonly RunId[]>
  findLatest(): Promise<RunId | undefined>
  findByPrefix(prefix: string): Promise<readonly RunId[]>
}

export class FileRunRegistry implements RunRegistry {
  constructor(_deps: { readonly fs: FsService; readonly basePath: Path }) {
    throw new Error('Not implemented')
  }

  listRuns(): Promise<readonly RunId[]> {
    throw new Error('Not implemented')
  }

  findLatest(): Promise<RunId | undefined> {
    throw new Error('Not implemented')
  }

  findByPrefix(_prefix: string): Promise<readonly RunId[]> {
    throw new Error('Not implemented')
  }
}
