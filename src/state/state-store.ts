// 364 lines — over 300-line soft limit because v3 schema migration
// (v2 discriminator + transform) lives alongside the store implementation.
// Extracting to a separate file would split read/write concerns.
import { z } from 'zod'
import type { FsService, Path } from '../services/index.ts'
import { path } from '../services/index.ts'
import type { PersistedValidation } from '../validators/index.ts'
import { RUN_ID_PATTERN, type RunId, runId } from './run-id.ts'

export interface StepEntry {
  readonly name: string
  readonly value: unknown
  readonly startedAt: number
  readonly endedAt: number
  readonly artifacts: readonly string[]
  /**
   * Captured pre-run baseline for validators that need one (git SHA).
   * Absent when no configured validator declared `needs: ['headSha']` or
   * when the cwd is not a git repo.
   */
  readonly preRunSnapshot?: { readonly headSha: string }
  /**
   * The post-run validator results. Always present (may be empty array)
   * so Phase 14 consumers can iterate without branching on absence.
   */
  readonly validations: ReadonlyArray<PersistedValidation>
  /** How this step was executed. Absent for pre-13a steps (implies autonomous). */
  readonly mode?: 'interactive' | 'autonomous'
}

export interface RunState {
  readonly schemaVersion: 3
  readonly id: RunId
  readonly status: 'running' | 'completed' | 'crashed'
  readonly workflowName?: string
  readonly startedAt: number
  readonly endedAt?: number
  readonly steps: Readonly<Record<string, StepEntry>>
}

export interface StateStore {
  loadRun(runId: RunId): Promise<RunState | undefined>
  saveStep(runId: RunId, entry: StepEntry): Promise<void>
  initRun(
    runId: RunId,
    meta?: { readonly workflowName?: string; readonly startedAt: number },
  ): Promise<void>
  setStatus(runId: RunId, status: RunState['status'], endedAt?: number): Promise<void>
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

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const PersistedValidationSchema = z.object({
  name: z.string().min(1),
  ok: z.boolean(),
  reason: z.string().optional(),
  hint: z.string().optional(),
})

/**
 * Regex-constrained SHA. This is the load-bearing security fix for
 * state-file poisoning: a malicious state file with
 * `headSha: '--upload-pack=/tmp/evil'` fails schema validation at load
 * time, before any git argv is ever constructed. See the phase 6 plan's
 * critical security fix #1.
 */
const PreRunSnapshotSchema = z.object({
  headSha: z.string().regex(/^[0-9a-f]{7,64}$/i),
})

export const StepEntrySchema = z.object({
  name: z.string().min(1),
  value: z.unknown(),
  startedAt: z.number(),
  endedAt: z.number(),
  artifacts: z.array(z.string()),
  preRunSnapshot: PreRunSnapshotSchema.optional(),
  validations: z.array(PersistedValidationSchema),
  mode: z.enum(['interactive', 'autonomous']).optional(),
})

const RunStateV2Schema = z.object({
  schemaVersion: z.literal(2),
  id: z.string().regex(RUN_ID_PATTERN),
  status: z.enum(['running', 'completed', 'crashed']),
  steps: z.record(z.string(), StepEntrySchema),
})

const RunStateV3Schema = z.object({
  schemaVersion: z.literal(3),
  id: z.string().regex(RUN_ID_PATTERN),
  status: z.enum(['running', 'completed', 'crashed']),
  workflowName: z.string().optional(),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  steps: z.record(z.string(), StepEntrySchema),
})

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * Wraps a Zod parse failure with an actionable message when the schema
 * version mismatch is the root cause. Prevents blind `rm -rf .orch/`
 * reflexes during the v1→v2 transition.
 */
function issueSummary(issues: readonly z.ZodIssue[]): string {
  return issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
}

function rebuildSteps(
  raw: Record<string, z.infer<typeof StepEntrySchema>>,
): Readonly<Record<string, StepEntry>> {
  const steps: Record<string, StepEntry> = {}
  for (const [key, s] of Object.entries(raw)) {
    steps[key] = {
      name: s.name,
      value: s.value,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      artifacts: s.artifacts,
      ...(s.preRunSnapshot !== undefined ? { preRunSnapshot: s.preRunSnapshot } : {}),
      validations: s.validations,
      ...(s.mode !== undefined ? { mode: s.mode } : {}),
    }
  }
  return steps
}

/**
 * O(1) version discriminator — checks `schemaVersion` field before full Zod
 * validation. Equivalent to `z.discriminatedUnion` but works with `.transform()`
 * (Zod 3.x discriminatedUnion requires ZodObject branches, not ZodEffects).
 */
function parseVersionedState(parsed: unknown, filePath: Path): RunState {
  const version =
    typeof parsed === 'object' && parsed !== null && 'schemaVersion' in parsed
      ? (parsed as { schemaVersion: unknown }).schemaVersion
      : undefined

  if (version === 2) {
    const r = RunStateV2Schema.safeParse(parsed)
    if (!r.success) throw wrapSchemaError(filePath, r.error.issues, issueSummary(r.error.issues))
    const v2 = r.data
    const entries = Object.values(v2.steps)
    return {
      schemaVersion: 3,
      id: runId(v2.id),
      status: v2.status,
      workflowName: undefined,
      startedAt: entries.length > 0 ? Math.min(...entries.map((s) => s.startedAt)) : 0,
      endedAt: undefined,
      steps: rebuildSteps(v2.steps),
    }
  }

  if (version === 3) {
    const r = RunStateV3Schema.safeParse(parsed)
    if (!r.success) throw wrapSchemaError(filePath, r.error.issues, issueSummary(r.error.issues))
    const d = r.data
    return {
      schemaVersion: 3,
      id: runId(d.id),
      status: d.status,
      workflowName: d.workflowName,
      startedAt: d.startedAt,
      endedAt: d.endedAt,
      steps: rebuildSteps(d.steps),
    }
  }

  // Unknown or missing version — try v3 schema for a structured error
  const r = RunStateV3Schema.safeParse(parsed)
  const summary = r.success ? 'unknown version' : issueSummary(r.error.issues)
  throw wrapSchemaError(filePath, r.success ? [] : r.error.issues, summary)
}

function wrapSchemaError(
  filePath: Path,
  issues: readonly z.ZodIssue[],
  summary: string,
): StateCorruptionError {
  const versionIssue = issues.find((i) => i.path[0] === 'schemaVersion')
  if (versionIssue) {
    return new StateCorruptionError(
      `State file at ${filePath} has an unsupported schema version; current is v3. ` +
        `Delete .orch/state/ to reset. (Zod: ${summary})`,
      filePath,
      issues,
    )
  }
  return new StateCorruptionError(`Corrupted state at ${filePath}: ${summary}`, filePath, issues)
}

export class FileStateStore implements StateStore {
  readonly #fs: FsService
  readonly #basePath: Path
  #tmpCounter = 0
  // Per-runId promise-chain serializer. Prevents concurrent read-modify-write
  // races in saveStep when parallel branches persist at the same time.
  // The chain uses .catch(() => {}) so a failed write doesn't block subsequent
  // writes — #doSaveStep re-reads from disk each time.
  readonly #writeQueue = new Map<string, Promise<void>>()

  constructor(deps: { readonly fs: FsService; readonly basePath: Path }) {
    this.#fs = deps.fs
    this.#basePath = deps.basePath
  }

  /** Number of active write-queue entries. Exposed for testing cleanup. */
  get writeQueueSize(): number {
    return this.#writeQueue.size
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
        { path: [], message: errorMessage(cause) } as unknown as z.ZodIssue,
      ])
    }

    return parseVersionedState(parsed, file)
  }

  async saveStep(rid: RunId, entry: StepEntry): Promise<void> {
    const prev = this.#writeQueue.get(rid) ?? Promise.resolve()
    const next = prev.then(() => this.#doSaveStep(rid, entry))
    // Swallow rejections on the chain reference so a failed write doesn't
    // prevent subsequent writes from starting.
    const swallowed = next.catch(() => {})
    this.#writeQueue.set(rid, swallowed)
    // Clean up when the chain goes idle (no new write was enqueued after us).
    swallowed.then(() => {
      if (this.#writeQueue.get(rid) === swallowed) this.#writeQueue.delete(rid)
    })
    // The caller awaits the real (unswallowed) promise — errors propagate.
    await next
  }

  async #doSaveStep(rid: RunId, entry: StepEntry): Promise<void> {
    const dir = this.#runDir(rid)
    const file = this.#statePath(rid)

    const existing = await this.loadRun(rid)
    const state: RunState = {
      schemaVersion: 3,
      id: rid,
      status: existing?.status ?? 'running',
      workflowName: existing?.workflowName,
      startedAt: existing?.startedAt ?? 0,
      endedAt: existing?.endedAt,
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

  // Note: resume() bypasses initRun() — it uses loadRun() + setStatus() instead.
  // If this method gains side effects, update resume() accordingly.
  async initRun(
    rid: RunId,
    meta?: { readonly workflowName?: string; readonly startedAt: number },
  ): Promise<void> {
    const existing = await this.loadRun(rid)
    if (existing !== undefined) return

    const dir = this.#runDir(rid)
    const file = this.#statePath(rid)
    const state: RunState = {
      schemaVersion: 3,
      id: rid,
      status: 'running',
      workflowName: meta?.workflowName,
      startedAt: meta?.startedAt ?? 0,
      steps: {},
    }

    await this.#fs.mkdir(dir, { recursive: true })
    await this.#atomicWrite(file, JSON.stringify(state, null, 2))
  }

  async setStatus(rid: RunId, status: RunState['status'], endedAt?: number): Promise<void> {
    const existing = await this.loadRun(rid)
    if (existing === undefined) {
      throw new Error(`Cannot set status: run "${rid}" does not exist`)
    }

    const file = this.#statePath(rid)
    const state: RunState = {
      ...existing,
      status,
      ...(endedAt !== undefined ? { endedAt } : {}),
    }

    await this.#atomicWrite(file, JSON.stringify(state, null, 2))
  }

  // NOTE: fsync-before-rename is deferred to Phase 10+. Power-loss window
  // between write and rename is acceptable pre-production.
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
