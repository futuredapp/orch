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
  /**
   * Relative path (within `.orch/state/<runId>/`) to the step's append-only
   * RunnerEvent sidecar — one JSON object per line. Absent when the step
   * emitted no events (silent steps, commit steps, interactive steps).
   */
  readonly transcriptPath?: string
  /** Total RunnerEvents appended to the sidecar. Zero when absent. */
  readonly transcriptEventCount: number
  /**
   * Whether the in-memory ring buffer dropped events before they hit disk.
   * Always false today (writer flushes every event); reserved for the v2
   * bounded-buffer mode.
   */
  readonly transcriptTruncated: boolean
  /**
   * Resume primitive for interactive agent steps — the upstream session /
   * thread identifier the runner consumed (Claude `--session-id`, Codex
   * `thread.started.thread_id`). Captured by the workflow executor only for
   * steps that emit it; absent on autonomous steps and on runners that lack
   * a resume primitive. Old state files (pre-Phase 3) load with this field
   * undefined and round-trip without injecting a `null` key.
   */
  readonly sessionId?: string
  /**
   * Diagnostic label for refusal messages — the `Runner.name` of the runner
   * that executed this step. Persisted on interactive agent steps only;
   * absent on autonomous steps and on pre-feature state files. Lookup of the
   * live runner instance still goes through `ResumeRegistry.getRunnerForStep`,
   * not this field — but the name lets the right pane distinguish "legacy step"
   * (no `runnerName`) from "step from this feature, registry not yet populated".
   */
  readonly runnerName?: string
  /**
   * Captured failure mode when a runner's `captureSessionId` did not yield a
   * usable id. Three discrete values:
   *   - `'ambiguous'` — multiple candidate sessions matched the cwd inside the
   *     capture window; orch refuses rather than guessing.
   *   - `'empty'` — no candidate session appeared within the timeout.
   *   - `'error'` — orch hit an internal/programming error during capture
   *     (e.g. `os.homedir()` empty, filesystem threw unexpectedly).
   * Persisted on interactive agent steps only and only when capture actually
   * ran; absent on autonomous steps and runners without `captureSessionId`.
   */
  readonly sessionIdCaptureError?: 'ambiguous' | 'empty' | 'error'
  /**
   * The sub-path this step ran under, deepest last. Empty (or absent —
   * absent treated as []) when the step ran at the workflow root. Persisted
   * so the projector can group rows by sub on resume without re-reading
   * `lifecycle.ndjson`. (U7)
   */
  readonly subPath?: readonly string[]
  /**
   * Opaque per-invocation token minted by `runWorkflow` and stashed on the
   * sub frame's ALS store. Used by `runStepOnce` (U4) to detect the
   * "same sub invoked twice in one run" collision case: when a step name
   * is about to be written under a key whose existing entry has the SAME
   * sub-path but a DIFFERENT subCallId, the second write is rejected with
   * `StepNameCollisionError`. Absent on root-frame steps and on legacy
   * state files. (U4 — R20 case b)
   */
  readonly subCallId?: string
  /**
   * Marks a step that ran inside (or transitively inside) a `parallel()`
   * branch. The projector reads this to suppress boundary-row rendering
   * uniformly across the entire sub-of-sub subtree (R23 / AE13). Absent on
   * steps that ran outside any parallel block. (U9)
   */
  readonly insideParallel?: true
  /**
   * Per-attempt error-recovery log (R16) — one entry per forked recovery
   * attempt, plus a terminal `gave-up` marker when the envelope was exhausted.
   * Present only on autonomous agent steps that actually recovered (the
   * `backoffResume` strategy forked at least once); absent on `noRetry` steps,
   * steps that succeeded first try, and pre-feature state files. Additive
   * optional — no `schemaVersion` bump. Persisted even on the failure path
   * (the loop saves a partial entry before the give-up `StepError`) so the
   * fork chain of a failed run survives in `state.json` for audit. The
   * canonical shape lives in `src/core/recovery/loop.ts` (`RecoveryLogEntry`);
   * this is its structural mirror, keeping `src/state` free of a `src/core`
   * dependency (same convention as `PersistedWorkflowArgs`).
   */
  readonly recoveryLog?: readonly PersistedRecoveryLogEntry[]
  /**
   * Set only on the partial entry the recovery loop persists *before* throwing
   * a give-up `StepError` (so the failure-path recovery log survives — R16).
   * Such an entry carries `value: undefined` and is NOT a successful result, so
   * `orch resume` must treat it as a cache miss and re-execute the step rather
   * than replaying `undefined`. Additive optional — no `schemaVersion` bump.
   */
  readonly recoveryGaveUp?: true
}

/**
 * One recovery-attempt record (R16). `errorClass` and `outcome` are typed as
 * `string` here — NOT a `z.enum` — so a value written by a future phase (Phase 2
 * shares this field) can never reject a whole Phase-1 state-file load. The core
 * loop produces the richer `RecoveryLogEntry` union; it is assignable to this.
 */
export interface PersistedRecoveryLogEntry {
  readonly attemptIndex: number
  readonly errorClass: string
  readonly waitMs: number
  readonly parentSessionId: string
  readonly forkSessionId?: string
  readonly outcome: string
}

/** Mirrors `WorkflowArgs` from `src/core/workflow.ts`. Kept structural here
 *  so `src/state` can stay dependency-free of `src/core`. */
export interface PersistedWorkflowArgs {
  readonly prompt?: string
}

export interface RunState {
  readonly schemaVersion: 5
  readonly id: RunId
  readonly status: 'running' | 'completed' | 'failed' | 'crashed'
  readonly workflowName?: string
  readonly startedAt: number
  readonly endedAt?: number
  readonly args?: PersistedWorkflowArgs
  readonly steps: Readonly<Record<string, StepEntry>>
}

export interface StateStore {
  loadRun(runId: RunId): Promise<RunState | undefined>
  saveStep(runId: RunId, entry: StepEntry): Promise<void>
  initRun(
    runId: RunId,
    meta?: {
      readonly workflowName?: string
      readonly startedAt: number
      readonly args?: PersistedWorkflowArgs
    },
  ): Promise<void>
  setStatus(runId: RunId, status: RunState['status'], endedAt?: number): Promise<void>
  /** Overwrite the persisted `args` of an existing run (used by `orch resume
   *  <id> "new-prompt"`). Throws if the run does not exist. */
  setArgs(runId: RunId, args: PersistedWorkflowArgs): Promise<void>
  /**
   * The absolute directory this store reads/writes for a run (`<basePath>/<runId>`).
   * Public so the executor can hand the resolved run state dir to a runner at
   * spawn (the predictable-fake control transport lives under it) without
   * re-deriving the base path. A pure path computation — no I/O, does not imply
   * the directory exists.
   */
  runDir(runId: RunId): Path
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
  transcriptPath: z.string().optional(),
  transcriptEventCount: z.number().int().nonnegative().default(0),
  transcriptTruncated: z.boolean().default(false),
  // Phase 3 — additive, no schemaVersion bump. Old state files (no field)
  // load with sessionId === undefined; new state writes the key only when
  // captured (spread-when-defined in rebuildSteps).
  sessionId: z.string().min(1).optional(),
  // History-resume — additive, no schemaVersion bump. Both fields are written
  // on interactive agent steps only. Old state files load with both undefined.
  runnerName: z.string().min(1).optional(),
  sessionIdCaptureError: z.enum(['ambiguous', 'empty', 'error']).optional(),
  // Subworkflows (U4, U7, U9) — additive, no schemaVersion bump. Old state
  // files load with all three undefined; the projector treats `subPath`
  // undefined as the empty path.
  subPath: z.array(z.string()).optional(),
  subCallId: z.string().min(1).optional(),
  insideParallel: z.literal(true).optional(),
  // Recovery log (U8/R16) — additive, no schemaVersion bump. `errorClass` and
  // `outcome` are `z.string()` (NOT a `z.enum`) so a forward/Phase-2 value never
  // rejects the whole state-file load; the TypeScript-level union lives in core.
  recoveryLog: z
    .array(
      z.object({
        attemptIndex: z.number().int().nonnegative(),
        errorClass: z.string(),
        waitMs: z.number().nonnegative(),
        parentSessionId: z.string(),
        forkSessionId: z.string().optional(),
        outcome: z.string(),
      }),
    )
    .optional(),
  // Recovery give-up marker (R16/resume-safety) — additive, no schemaVersion
  // bump. Marks a partial entry persisted before a give-up throw so resume
  // re-executes instead of replaying its `undefined` value as a cache hit.
  recoveryGaveUp: z.literal(true).optional(),
})

const PersistedWorkflowArgsSchema = z.object({
  prompt: z.string().optional(),
})

const RunStateV5Schema = z.object({
  schemaVersion: z.literal(5),
  id: z.string().regex(RUN_ID_PATTERN),
  status: z.enum(['running', 'completed', 'failed', 'crashed']),
  workflowName: z.string().optional(),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  args: PersistedWorkflowArgsSchema.optional(),
  steps: z.record(z.string(), StepEntrySchema),
})

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

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
      ...(s.transcriptPath !== undefined ? { transcriptPath: s.transcriptPath } : {}),
      transcriptEventCount: s.transcriptEventCount,
      transcriptTruncated: s.transcriptTruncated,
      ...(s.sessionId !== undefined ? { sessionId: s.sessionId } : {}),
      ...(s.runnerName !== undefined ? { runnerName: s.runnerName } : {}),
      ...(s.sessionIdCaptureError !== undefined
        ? { sessionIdCaptureError: s.sessionIdCaptureError }
        : {}),
      ...(s.subPath !== undefined ? { subPath: s.subPath } : {}),
      ...(s.subCallId !== undefined ? { subCallId: s.subCallId } : {}),
      ...(s.insideParallel !== undefined ? { insideParallel: s.insideParallel } : {}),
      ...(s.recoveryLog !== undefined ? { recoveryLog: s.recoveryLog } : {}),
      ...(s.recoveryGaveUp !== undefined ? { recoveryGaveUp: s.recoveryGaveUp } : {}),
    }
  }
  return steps
}

// Prerelease: no v2/v3/v4 migration paths. A pre-v5 state file is rejected
// with a wipe hint rather than silently upgraded — orch has no external
// users, and every breaking change is one `rm -rf .orch/state` away.
function parseV5(parsed: unknown, filePath: Path): RunState {
  const r = RunStateV5Schema.safeParse(parsed)
  if (!r.success) throw wrapSchemaError(filePath, r.error.issues, issueSummary(r.error.issues))
  const d = r.data
  return {
    schemaVersion: 5,
    id: runId(d.id),
    status: d.status,
    workflowName: d.workflowName,
    startedAt: d.startedAt,
    endedAt: d.endedAt,
    ...(d.args !== undefined ? { args: d.args } : {}),
    steps: rebuildSteps(d.steps),
  }
}

function parseVersionedState(parsed: unknown, filePath: Path): RunState {
  const version =
    typeof parsed === 'object' && parsed !== null && 'schemaVersion' in parsed
      ? (parsed as { schemaVersion: unknown }).schemaVersion
      : undefined

  if (version === 5) return parseV5(parsed, filePath)

  // Any non-5 version is unsupported. Fail fast with a wipe hint rather
  // than silently attempting a v4-shaped parse.
  throw new StateCorruptionError(
    `State file at ${filePath} has unsupported schema version ${
      version === undefined ? '(missing)' : JSON.stringify(version)
    }; current is v5. Wipe .orch/state/ and re-run (prerelease, no migrations).`,
    filePath,
    [],
  )
}

function wrapSchemaError(
  filePath: Path,
  issues: readonly z.ZodIssue[],
  summary: string,
): StateCorruptionError {
  const versionIssue = issues.find((i) => i.path[0] === 'schemaVersion')
  if (versionIssue) {
    return new StateCorruptionError(
      `State file at ${filePath} has an unsupported schema version; current is v5. ` +
        `Wipe .orch/state/ and re-run (prerelease, no migrations). (Zod: ${summary})`,
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
      schemaVersion: 5,
      id: rid,
      status: existing?.status ?? 'running',
      workflowName: existing?.workflowName,
      startedAt: existing?.startedAt ?? 0,
      endedAt: existing?.endedAt,
      ...(existing?.args !== undefined ? { args: existing.args } : {}),
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
    meta?: {
      readonly workflowName?: string
      readonly startedAt: number
      readonly args?: PersistedWorkflowArgs
    },
  ): Promise<void> {
    const existing = await this.loadRun(rid)
    if (existing !== undefined) return

    const dir = this.#runDir(rid)
    const file = this.#statePath(rid)
    const state: RunState = {
      schemaVersion: 5,
      id: rid,
      status: 'running',
      workflowName: meta?.workflowName,
      startedAt: meta?.startedAt ?? 0,
      ...(meta?.args !== undefined ? { args: meta.args } : {}),
      steps: {},
    }

    await this.#fs.mkdir(dir, { recursive: true })
    await this.#atomicWrite(file, JSON.stringify(state, null, 2))
  }

  async setArgs(rid: RunId, args: PersistedWorkflowArgs): Promise<void> {
    const existing = await this.loadRun(rid)
    if (existing === undefined) {
      throw new Error(`Cannot set args: run "${rid}" does not exist`)
    }

    const file = this.#statePath(rid)
    const state: RunState = {
      ...existing,
      args,
    }

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

  /** Public accessor for `<basePath>/<runId>`. Delegates to the private
   *  `#runDir` so the layout stays defined in exactly one place. */
  runDir(rid: RunId): Path {
    return this.#runDir(rid)
  }

  #runDir(rid: RunId): Path {
    return path(`${this.#basePath}/${rid}`)
  }

  #statePath(rid: RunId): Path {
    return path(`${this.#runDir(rid)}/state.json`)
  }
}
