import { z } from 'zod'
import type { FsService, Path } from '../services/index.ts'
import { path } from '../services/index.ts'
import { RUN_ID_PATTERN, type RunId, runId } from './run-id.ts'

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

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export class FileStateStore implements StateStore {
  readonly #fs: FsService
  readonly #basePath: Path
  #tmpCounter = 0

  constructor(deps: { readonly fs: FsService; readonly basePath: Path }) {
    this.#fs = deps.fs
    this.#basePath = deps.basePath
  }

  async loadRun(rid: RunId): Promise<RunState | undefined> {
    const file = this.#statePath(rid)

    let raw: string
    try {
      raw = await this.#fs.readFile(file)
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
        return undefined
      }
      // FakeFsService and some environments throw Error objects whose message
      // starts with "ENOENT:" but without a `code` field. Treat that prefix as
      // not-found to preserve round-trip semantics without swallowing real errors.
      if (err instanceof Error && err.message.startsWith('ENOENT')) {
        return undefined
      }
      throw err
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (cause) {
      throw new StateCorruptionError(`Failed to parse JSON at ${file}`, file, [
        { path: [], message: errorMessage(cause) },
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

    const data = result.data
    const steps: Record<string, StepEntry> = {}
    for (const [key, step] of Object.entries(data.steps)) {
      steps[key] = {
        name: step.name,
        value: step.value,
        startedAt: step.startedAt,
        endedAt: step.endedAt,
        artifacts: step.artifacts,
      }
    }
    return {
      schemaVersion: data.schemaVersion,
      id: runId(data.id),
      status: data.status,
      steps,
    }
  }

  async saveStep(rid: RunId, entry: StepEntry): Promise<void> {
    const dir = this.#runDir(rid)
    const file = this.#statePath(rid)

    const existing = await this.loadRun(rid)
    const state: RunState = {
      schemaVersion: 1,
      id: rid,
      status: existing?.status ?? 'running',
      steps: { ...existing?.steps, [entry.name]: entry },
    }

    let json: string
    try {
      json = JSON.stringify(state, null, 2)
    } catch (cause) {
      throw new Error(`Failed to serialize step "${entry.name}": ${errorMessage(cause)}`, {
        cause,
      })
    }

    await this.#fs.mkdir(dir, { recursive: true })
    await this.#atomicWrite(file, json)
  }

  async initRun(rid: RunId): Promise<void> {
    const existing = await this.loadRun(rid)
    if (existing !== undefined) return

    const dir = this.#runDir(rid)
    const file = this.#statePath(rid)
    const state: RunState = {
      schemaVersion: 1,
      id: rid,
      status: 'running',
      steps: {},
    }

    await this.#fs.mkdir(dir, { recursive: true })
    await this.#atomicWrite(file, JSON.stringify(state, null, 2))
  }

  async setStatus(rid: RunId, status: RunState['status']): Promise<void> {
    const existing = await this.loadRun(rid)
    if (existing === undefined) {
      throw new Error(`Cannot set status: run "${rid}" does not exist`)
    }

    const file = this.#statePath(rid)
    const state: RunState = { ...existing, status }

    await this.#atomicWrite(file, JSON.stringify(state, null, 2))
  }

  async #atomicWrite(filePath: Path, json: string): Promise<void> {
    const tmp = this.#nextTmpPath(filePath)
    try {
      await this.#fs.writeFile(tmp, json)
      await this.#fs.rename(tmp, filePath)
    } catch (err) {
      await this.#fs.remove(tmp).catch(() => {})
      throw err
    }
  }

  #nextTmpPath(filePath: Path): Path {
    this.#tmpCounter += 1
    return path(`${filePath}.${process.pid}-${this.#tmpCounter}.tmp`)
  }

  #runDir(rid: RunId): Path {
    return path(`${this.#basePath}/${rid}`)
  }

  #statePath(rid: RunId): Path {
    return path(`${this.#runDir(rid)}/state.json`)
  }
}
