/**
 * Workflow-state matchers. Pure projectors over `LifecycleSnapshot`'s
 * `stateStatus` / `stepStatuses` fields.
 */

import type { LifecycleSnapshot, Matcher, StateStatus, StepStatus } from './internal/snapshot.ts'

export const isRunningStep = (stepName: string): Matcher => {
  return (snapshot: LifecycleSnapshot) => {
    // Plan §6.5: a step is "running" while the run is running AND the step's
    // entry is either absent (executor hasn't finalized it yet) or its
    // `value` is undefined. The snapshot collapses both shapes into the
    // `'unknown'` step status; we check that alongside `stateStatus`.
    if (snapshot.stateStatus !== 'running') {
      return {
        matched: false,
        message: `isRunningStep("${stepName}"): stateStatus=${snapshot.stateStatus} (expected "running")`,
      }
    }
    const status = snapshot.stepStatuses[stepName]
    // 'unknown' (entry-missing or value-missing) and explicit 'running' both
    // satisfy. 'completed'/'failed'/'skipped' do not.
    if (status === undefined || status === 'unknown' || status === 'running') {
      return { matched: true, message: `isRunningStep("${stepName}"): step is mid-flight` }
    }
    return {
      matched: false,
      message: `isRunningStep("${stepName}"): stepStatuses["${stepName}"]=${status}`,
    }
  }
}

export const hasStatus = (status: StateStatus): Matcher => {
  return (snapshot: LifecycleSnapshot) => {
    if (snapshot.stateStatus === status) {
      return { matched: true, message: `hasStatus("${status}"): matches` }
    }
    return {
      matched: false,
      message: `hasStatus("${status}"): stateStatus=${snapshot.stateStatus}`,
    }
  }
}

export const hasStepStatus = (stepName: string, status: StepStatus): Matcher => {
  return (snapshot: LifecycleSnapshot) => {
    const actual = snapshot.stepStatuses[stepName]
    if (actual === status) {
      return { matched: true, message: `hasStepStatus("${stepName}", "${status}"): matches` }
    }
    return {
      matched: false,
      message: `hasStepStatus("${stepName}", "${status}"): actual=${actual ?? 'undefined'}`,
    }
  }
}

export const hasExitCode = (code: number): Matcher => {
  return (snapshot: LifecycleSnapshot) => {
    if (snapshot.orchExit?.code === code) {
      return { matched: true, message: `hasExitCode(${code}): matches` }
    }
    return {
      matched: false,
      message: `hasExitCode(${code}): orchExit=${snapshot.orchExit === null ? 'null' : `code=${snapshot.orchExit.code}`}`,
    }
  }
}

export const hasExitedBySignal = (signal: NodeJS.Signals): Matcher => {
  return (snapshot: LifecycleSnapshot) => {
    if (snapshot.orchExit?.signal === signal) {
      return { matched: true, message: `hasExitedBySignal("${signal}"): matches` }
    }
    return {
      matched: false,
      message: `hasExitedBySignal("${signal}"): orchExit.signal=${snapshot.orchExit?.signal ?? 'null'}`,
    }
  }
}

// ---------------------------------------------------------------------------
// Behavioral aliases / sugar — clearer reading for behavioral cells.
// ---------------------------------------------------------------------------

export const hasStepCompleted = (stepName: string): Matcher => {
  // The current snapshot only resolves step entries to 'completed' or 'unknown'
  // (see internal/snapshot.ts readStateJson). 'unknown' covers both not-yet-
  // started and mid-flight. So this matcher is equivalent to
  // `hasStepStatus(name, 'completed')` until the snapshot tracks failure.
  return hasStepStatus(stepName, 'completed')
}

/**
 * Sugar matcher for `hasStepStatus(name, 'failed')`. The snapshot resolves
 * failure by scanning `logs/lifecycle.ndjson` for a `step:failed` entry,
 * since `saveStep` is skipped when a step throws (workflow.ts:1235-1252).
 */
export const hasStepFailed = (stepName: string): Matcher => {
  return hasStepStatus(stepName, 'failed')
}

export const hasRunStatus = (status: StateStatus): Matcher => {
  // Clearer alias of `hasStatus(status)` for behavioral cells that want the
  // word "run" in the assertion narrative.
  return hasStatus(status)
}
