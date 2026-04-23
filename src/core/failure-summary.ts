// ---------------------------------------------------------------------------
// FailureSummary — host-agnostic value for Story 1.5 inline failure frames.
// ---------------------------------------------------------------------------
//
// `step:failed` is emitted by the workflow executor; every host turns the same
// value into its own frame (plain → stderr block, two-pane → right-pane
// paragraph). Splitting the data from the rendering keeps each host small and
// lets tests assert shape without pinning on ANSI bytes.
//
// The hints (`resumeHint`, `logsHint`) are composed here so every surface
// shows the user the exact command to copy — the `orch resume <runId>` /
// `orch logs <runId>` copy lives in one place.

import type { RunId, StepName } from './types.ts'

export interface FailureSummary {
  readonly stepName: StepName
  readonly runId: RunId
  readonly errorMessage: string
  /** Stack lines, pre-split. Empty when the error is a plain string. */
  readonly stackTrace: readonly string[]
  /** Copy/paste command the user can run to resume the failed run. */
  readonly resumeHint: string
  /** Copy/paste command the user can run to inspect the full transcript. */
  readonly logsHint: string
  readonly failedAt: number
  /** Steps downstream of the failure that will be skipped on resume. */
  readonly downstream: readonly StepName[]
}

export interface SummarizeFailureInputs {
  readonly stepName: StepName
  readonly runId: RunId
  readonly error: unknown
  readonly failedAt: number
  /** Downstream step names the executor already knew about. */
  readonly downstream?: readonly StepName[]
}

export function summarizeFailure(inputs: SummarizeFailureInputs): FailureSummary {
  const { error } = inputs
  const errorMessage = formatErrorMessage(error)
  const stackTrace = extractStackTrace(error)

  return {
    stepName: inputs.stepName,
    runId: inputs.runId,
    errorMessage,
    stackTrace,
    resumeHint: `orch resume ${inputs.runId}`,
    logsHint: `orch logs ${inputs.runId}`,
    failedAt: inputs.failedAt,
    downstream: inputs.downstream ?? [],
  }
}

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

function extractStackTrace(err: unknown): readonly string[] {
  if (!(err instanceof Error)) return []
  const stack = err.stack
  if (stack === undefined || stack.length === 0) return []
  // Error.stack starts with "<name>: <message>" on the first line — the
  // FailureSummary already carries that via errorMessage, so drop it.
  const lines = stack.split('\n').map((l) => l.trimEnd())
  return lines.slice(1).filter((l) => l.length > 0)
}
