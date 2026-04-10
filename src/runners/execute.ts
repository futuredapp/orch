import type { Clock } from '../services/clock/clock.ts'
import type { ProcessService } from '../services/process/process-service.ts'
import type { Runner, RunnerContext, RunnerEvent, TerminalEvent } from './types.ts'

export interface RunnerResult {
  readonly events: readonly RunnerEvent[]
  readonly finalEvent: TerminalEvent
  readonly exitCode: number
  readonly durationMs: number
  readonly structuredOutput?: unknown
}

export async function runRunner(
  _runner: Runner,
  _ctx: RunnerContext,
  _deps: {
    readonly processService: ProcessService
    readonly clock: Clock
  },
): Promise<RunnerResult> {
  throw new Error('not implemented')
}
