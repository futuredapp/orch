import { z } from 'zod'
import type { FsService } from '../services/index.ts'
import { type Path, path } from '../services/types.ts'
import { RUN_ID_PATTERN, type RunId } from './run-id.ts'

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
  initRun(runId: RunId): Promise<void>
  setStatus(runId: RunId, status: RunState['status']): Promise<void>
}

export class StateCorruptionError extends Error {
  constructor(
    message: string,
    readonly filePath: Path,
    readonly zodIssues: readonly {
      readonly path: readonly (string | number)[]
      readonly message: string
    }[],
  ) {
    super(message)
    this.name = 'StateCorruptionError'
  }
}

const StepEntrySchema = z.object({
  name: z.string().min(1),
  value: z.unknown(),
  startedAt: z.number(),
  endedAt: z.number(),
  artifacts: z.array(z.string()),
})

const RunStateSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(RUN_ID_PATTERN),
  status: z.enum(['running', 'completed', 'crashed']),
  steps: z.record(z.string(), StepEntrySchema),
})

export class FileStateStore implements StateStore {
  readonly #fs: FsService
  readonly #basePath: Path

  constructor(deps: { readonly fs: FsService; readonly basePath: Path }) {
    this.#fs = deps.fs
    this.#basePath = deps.basePath
  }

  async loadRun(runId: RunId): Promise<RunState | undefined> {
    const file = this.#statePath(runId)

    let raw: string
    try {
      raw = await this.#fs.readFile(file)
    } catch {
      return undefined
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (cause) {
      throw new StateCorruptionError(`Failed to parse JSON at ${file}`, file, [
        { path: [], message: (cause as Error).message },
      ])
    }

    const result = RunStateSchema.safeParse(parsed)
    if (!result.success) {
      const summary = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
      throw new StateCorruptionError(
        `Corrupted state at ${file}: ${summary}`,
        file,
        result.error.issues,
      )
    }

    return result.data as unknown as RunState
  }

  async saveStep(runId: RunId, entry: StepEntry): Promise<void> {
    const dir = this.#runDir(runId)
    const file = this.#statePath(runId)
    const tmp = this.#tmpPath(runId)

    const existing = await this.loadRun(runId)
    const state: RunState = {
      schemaVersion: 1,
      id: runId,
      status: existing?.status ?? 'running',
      steps: { ...existing?.steps, [entry.name]: entry },
    }

    let json: string
    try {
      json = JSON.stringify(state, null, 2)
    } catch (cause) {
      throw new Error(`Failed to serialize step "${entry.name}": ${(cause as Error).message}`, {
        cause,
      })
    }

    await this.#fs.mkdir(dir, { recursive: true })
    await this.#fs.writeFile(tmp, json)
    await this.#fs.rename(tmp, file)
  }

  async initRun(runId: RunId): Promise<void> {
    const existing = await this.loadRun(runId)
    if (existing !== undefined) return

    const dir = this.#runDir(runId)
    const file = this.#statePath(runId)
    const tmp = this.#tmpPath(runId)

    const state: RunState = {
      schemaVersion: 1,
      id: runId,
      status: 'running',
      steps: {},
    }

    await this.#fs.mkdir(dir, { recursive: true })
    await this.#fs.writeFile(tmp, JSON.stringify(state, null, 2))
    await this.#fs.rename(tmp, file)
  }

  async setStatus(runId: RunId, status: RunState['status']): Promise<void> {
    const existing = await this.loadRun(runId)
    if (existing === undefined) {
      throw new Error(`Cannot set status: run "${runId}" does not exist`)
    }

    const file = this.#statePath(runId)
    const tmp = this.#tmpPath(runId)
    const state: RunState = { ...existing, status }

    await this.#fs.writeFile(tmp, JSON.stringify(state, null, 2))
    await this.#fs.rename(tmp, file)
  }

  // TODO(phase-8): saveStep does load-then-write (non-atomic). Safe for Phase 4
  // (sequential), but parallel() needs locking or CAS.

  #runDir(runId: RunId): Path {
    return path(`${this.#basePath}/${runId}`)
  }

  #statePath(runId: RunId): Path {
    return path(`${this.#runDir(runId)}/state.json`)
  }

  #tmpPath(runId: RunId): Path {
    return path(`${this.#statePath(runId)}.tmp`)
  }
}
