import type { Runner } from '../runners/index.ts'
import type { StepName } from './types.ts'

/**
 * Live, step-keyed map from `StepName` to the `Runner` instance that executed
 * (or replayed) that step in the current workflow execution.
 *
 * Owned at the CLI layer; passed by reference into both the host stack
 * (so the right-pane controller can resolve a runner on Enter) and the
 * workflow executor (so `runStepOnce` populates it at the start of each
 * interactive agent step).
 *
 * Step-keyed, not name-keyed: two `claude({modelA})` and `claude({modelB})`
 * instances used by different steps each resolve to their own runner via the
 * `StepName` they were registered against. A name-keyed map would collide on
 * `Runner.name === 'claude'` and last-write-wins silently routes some resumes
 * to the wrong config.
 *
 * Not persisted — pure in-memory, scoped to one execution. Resumed runs
 * rebuild it as the executor replays `run(step)` calls (including cache
 * hits, so the registry populates progressively during replay).
 */
export interface ResumeRegistry {
  register(stepName: StepName, runner: Runner): void
  getRunnerForStep(stepName: StepName): Runner | undefined
}

export function createResumeRegistry(): ResumeRegistry {
  const byStep = new Map<StepName, Runner>()
  return {
    register(stepName, runner) {
      byStep.set(stepName, runner)
    },
    getRunnerForStep(stepName) {
      return byStep.get(stepName)
    },
  }
}
