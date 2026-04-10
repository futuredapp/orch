import type { FsService } from '../services/index.ts'
import type { Path } from '../services/types.ts'
import { RUN_ID_PATTERN, type RunId, runId } from './run-id.ts'

export interface RunRegistry {
  listRuns(): Promise<readonly RunId[]>
  findLatest(): Promise<RunId | undefined>
  findByPrefix(prefix: string): Promise<readonly RunId[]>
}

export class FileRunRegistry implements RunRegistry {
  readonly #fs: FsService
  readonly #basePath: Path

  constructor(deps: { readonly fs: FsService; readonly basePath: Path }) {
    this.#fs = deps.fs
    this.#basePath = deps.basePath
  }

  async listRuns(): Promise<readonly RunId[]> {
    const exists = await this.#fs.exists(this.#basePath)
    if (!exists) return []

    const entries = await this.#fs.readDir(this.#basePath)
    return entries
      .filter((e) => RUN_ID_PATTERN.test(e))
      .sort()
      .map((e) => runId(e))
  }

  async findLatest(): Promise<RunId | undefined> {
    const runs = await this.listRuns()
    return runs.at(-1) ?? undefined
  }

  async findByPrefix(prefix: string): Promise<readonly RunId[]> {
    const runs = await this.listRuns()
    return runs.filter((id) => id.startsWith(prefix))
  }
}
