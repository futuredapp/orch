import type { RunState } from '../state/index.ts'
import type { RunId, StepName } from './types.ts'

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

export class RunNotFoundError extends Error {
  constructor(readonly runId: RunId) {
    super(`Cannot resume: run "${runId}" not found`)
    this.name = 'RunNotFoundError'
  }
}

export class ResumeError extends Error {
  constructor(
    readonly runId: RunId,
    readonly status: RunState['status'],
  ) {
    super(`Cannot resume run "${runId}": run already completed`)
    this.name = 'ResumeError'
  }
}

export class InteractiveParallelError extends Error {
  constructor(readonly stepName: StepName) {
    super(
      `Interactive step "${stepName}" cannot run inside parallel() — ` +
        'interactive steps are inherently sequential',
    )
    this.name = 'InteractiveParallelError'
  }
}

export class RunnerCapabilityError extends Error {
  constructor(
    readonly stepName: StepName,
    readonly runnerName: string,
  ) {
    super(
      `Runner "${runnerName}" does not support interactive mode; ` +
        `step "${stepName}" requires a runner with supports.interactive = true`,
    )
    this.name = 'RunnerCapabilityError'
  }
}
