import { type RunnerContext, runRunner } from '../runners/index.ts'
import type { Clock, ProcessService } from '../services/index.ts'
import type { StateStore, StepEntry } from '../state/index.ts'
import type { Step } from './step.ts'
import { type Path, type RunId, type StepName, stepName } from './types.ts'

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
}

// ---------------------------------------------------------------------------
// RunFn — the signature of the `run` closure passed to workflow functions
// ---------------------------------------------------------------------------

export type RunFn = (step: Step, overrides?: RunOverrides) => Promise<unknown>

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
// workflow — the core DSL entry point
// ---------------------------------------------------------------------------

export function workflow(name: string, fn: (run: RunFn) => Promise<void>): WorkflowExecutor {
  return {
    name,
    async execute(deps: WorkflowDeps): Promise<void> {
      await deps.stateStore.initRun(deps.runId)

      const run: RunFn = async (s: Step, overrides?: RunOverrides): Promise<unknown> => {
        const key = stepName(overrides?.as ?? s.name)

        const state = await deps.stateStore.loadRun(deps.runId)
        const cached = state?.steps[key]
        if (cached !== undefined) return cached.value

        const prompt = assemblePrompt(s.config.prompt, overrides)
        const ctx: RunnerContext = {
          cwd: deps.cwd,
          env: {},
          prompt,
          extraArgs: [],
        }

        const startedAt = deps.clock.now()
        const result = await runRunner(s.config.agent, ctx, {
          processService: deps.processService,
          clock: deps.clock,
        })

        const isError = result.finalEvent.type === 'error' || result.exitCode !== 0
        if (isError) {
          const msg =
            result.finalEvent.type === 'error'
              ? result.finalEvent.message
              : `runner exited ${result.exitCode}`
          throw new StepError(key, result.exitCode, msg)
        }

        const value = s.config.agent.extractStructuredOutput(result.finalEvent)
        const endedAt = deps.clock.now()

        const entry: StepEntry = {
          name: key,
          value,
          startedAt,
          endedAt,
          artifacts: [],
        }
        await deps.stateStore.saveStep(deps.runId, entry)

        return value
      }

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
