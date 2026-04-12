import { runRunner } from '../runners/index.ts'
import type { Clock, FsService, GitService, ProcessService } from '../services/index.ts'
import { GitCommandError } from '../services/index.ts'
import type { StateStore, StepEntry } from '../state/index.ts'
import {
  anyNeedsHeadSha,
  normalizeValidators,
  ValidationError,
  type ValidatorCtx,
  type ValidatorServices,
} from '../validators/index.ts'
import { SchemaValidationError } from './schema.ts'
import type { Step } from './step.ts'
import { type Path, type RunId, type StepName, stepName } from './types.ts'
import { outcomesToFailures, outcomesToPersisted, runValidators } from './validation-runner.ts'

// ---------------------------------------------------------------------------
// JsonValue — compile-time serialization safety for extraContext
// ---------------------------------------------------------------------------

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }

// ---------------------------------------------------------------------------
// RunOverrides — per-call overrides for run()
// ---------------------------------------------------------------------------

export interface RunOverrides {
  readonly as?: string
  readonly prompt?: string
  readonly extraContext?: JsonValue
  readonly extraPrompt?: string
}

// ---------------------------------------------------------------------------
// WorkflowDeps — everything the executor needs
// ---------------------------------------------------------------------------

export interface WorkflowDeps {
  readonly stateStore: StateStore
  readonly processService: ProcessService
  readonly clock: Clock
  readonly runId: RunId
  readonly cwd: Path
  readonly fsService: FsService
  readonly gitService: GitService
}

// ---------------------------------------------------------------------------
// RunFn — the signature of the `run` closure passed to workflow functions
// ---------------------------------------------------------------------------

export type RunFn = <T>(step: Step<T>, overrides?: RunOverrides) => Promise<T>

// ---------------------------------------------------------------------------
// WorkflowExecutor — returned by workflow()
// ---------------------------------------------------------------------------

export interface WorkflowExecutor {
  readonly name: string
  execute(deps: WorkflowDeps): Promise<void>
}

// ---------------------------------------------------------------------------
// StepError — thrown when a runner returns an error terminal event
// ---------------------------------------------------------------------------

export class StepError extends Error {
  constructor(
    readonly stepName: StepName,
    readonly exitCode: number,
    message: string,
  ) {
    super(`Step "${stepName}" failed (exit ${exitCode}): ${message}`)
    this.name = 'StepError'
  }
}

// ---------------------------------------------------------------------------
// assemblePrompt — builds the final prompt from defaults and overrides
// ---------------------------------------------------------------------------

function assemblePrompt(
  defaultPrompt: string | undefined,
  overrides: RunOverrides | undefined,
): string {
  const base = overrides?.prompt ?? defaultPrompt ?? ''
  const parts = [base]
  if (overrides?.extraContext !== undefined) {
    parts.push(JSON.stringify(overrides.extraContext, null, 2))
  }
  if (overrides?.extraPrompt) parts.push(overrides.extraPrompt)
  return parts.filter(Boolean).join('\n\n')
}

// ---------------------------------------------------------------------------
// safeHeadSha — best-effort baseline capture
// ---------------------------------------------------------------------------
//
// Returns undefined when cwd is not a git repo. Only swallows GitCommandError;
// other error classes (e.g. ProcessSpawnError when git is missing entirely)
// propagate as real runtime errors.
async function safeHeadSha(git: GitService, cwd: Path): Promise<string | undefined> {
  try {
    return await git.headSha(cwd)
  } catch (err) {
    if (err instanceof GitCommandError) return undefined
    throw err
  }
}

// ---------------------------------------------------------------------------
// Schema helpers — extracted for cognitive complexity budget
// ---------------------------------------------------------------------------

function checkSchemaCapability(step: Step, key: StepName): void {
  if (step.config.returns !== undefined && !step.config.agent.supports.structuredOutput) {
    throw new Error(
      `Runner "${step.config.agent.name}" does not support structured output; ` +
        `remove "returns:" from step "${key}" or use a runner that supports it`,
    )
  }
}

function revalidateCachedValue(step: Step, key: StepName, cached: unknown): void {
  if (step.config.returns === undefined) return
  const reparse = step.config.returns.zodSchema.safeParse(cached)
  if (!reparse.success) throw new SchemaValidationError(key, reparse.error)
}

function validateSchemaOutput(step: Step, key: StepName, rawValue: unknown): unknown {
  if (step.config.returns === undefined) return rawValue

  if (rawValue === undefined) {
    throw new Error(
      `Step "${key}": runner "${step.config.agent.name}" returned no structured_output ` +
        'despite --json-schema being set. Check CLI version and flag compatibility.',
    )
  }
  const parseResult = step.config.returns.zodSchema.safeParse(rawValue)
  if (!parseResult.success) throw new SchemaValidationError(key, parseResult.error)
  return parseResult.data
}

// ---------------------------------------------------------------------------
// workflow — the core DSL entry point
// ---------------------------------------------------------------------------

async function runStepOnce(
  deps: WorkflowDeps,
  s: Step,
  overrides: RunOverrides | undefined,
): Promise<unknown> {
  const key = stepName(overrides?.as ?? s.name)

  // Cache-hit early return MUST come before any git/baseline work —
  // resume runs must do zero git subprocess calls.
  const state = await deps.stateStore.loadRun(deps.runId)
  const cached = state?.steps[key]
  if (cached !== undefined) {
    revalidateCachedValue(s, key, cached.value)
    return cached.value
  }

  checkSchemaCapability(s, key)

  const normalized = normalizeValidators(s.config.validate, key)
  const headSha = anyNeedsHeadSha(normalized)
    ? await safeHeadSha(deps.gitService, deps.cwd)
    : undefined
  const preRunSnapshot = headSha !== undefined ? { headSha } : undefined

  const startedAt = deps.clock.now()
  const result = await runRunner(
    s.config.agent,
    {
      cwd: deps.cwd,
      env: {},
      prompt: assemblePrompt(s.config.prompt, overrides),
      extraArgs: [],
      ...(s.config.returns !== undefined
        ? { schema: { jsonSchema: s.config.returns.jsonSchema } }
        : {}),
    },
    { processService: deps.processService, clock: deps.clock },
  )

  if (result.finalEvent.type === 'error' || result.exitCode !== 0) {
    const msg =
      result.finalEvent.type === 'error'
        ? result.finalEvent.message
        : `runner exited ${result.exitCode}`
    throw new StepError(key, result.exitCode, msg)
  }

  const rawValue = s.config.agent.extractStructuredOutput(result.finalEvent)
  const value = validateSchemaOutput(s, key, rawValue)

  const validatorCtx: ValidatorCtx = {
    stepName: key,
    cwd: deps.cwd,
    value,
    ...(preRunSnapshot !== undefined ? { preRunSnapshot } : {}),
  }
  const services: ValidatorServices = { fs: deps.fsService, git: deps.gitService }
  const outcomes = await runValidators(normalized, services, validatorCtx)
  const failures = outcomesToFailures(outcomes)
  if (failures.length > 0) {
    throw new ValidationError(key, failures)
  }

  const entry: StepEntry = {
    name: key,
    value,
    startedAt,
    endedAt: deps.clock.now(),
    artifacts: [],
    ...(preRunSnapshot !== undefined ? { preRunSnapshot } : {}),
    validations: outcomesToPersisted(outcomes),
  }
  await deps.stateStore.saveStep(deps.runId, entry)
  return value
}

export function workflow(name: string, fn: (run: RunFn) => Promise<void>): WorkflowExecutor {
  return {
    name,
    async execute(deps: WorkflowDeps): Promise<void> {
      await deps.stateStore.initRun(deps.runId)

      const run: RunFn = <T>(s: Step<T>, overrides?: RunOverrides): Promise<T> =>
        runStepOnce(deps, s, overrides) as Promise<T>

      try {
        await fn(run)
        await deps.stateStore.setStatus(deps.runId, 'completed')
      } catch (err) {
        try {
          await deps.stateStore.setStatus(deps.runId, 'crashed')
        } catch {
          // Swallow setStatus failure — if initRun failed (disk full),
          // the catch tries setStatus on a non-existent run, which throws.
          // Without this inner try-catch, the original error is lost.
        }
        throw err
      }
    },
  }
}
