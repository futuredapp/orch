import type { Clock } from '../services/clock/clock.ts'
import type { ProcessService } from '../services/process/process-service.ts'
import type { Runner, RunnerContext, RunnerEvent, TerminalEvent } from './types.ts'
import { isTerminalEvent } from './types.ts'

export interface RunnerResult {
  readonly events: readonly RunnerEvent[]
  readonly finalEvent: TerminalEvent
  readonly exitCode: number
  readonly durationMs: number
  readonly structuredOutput?: unknown
}

export async function runRunner(
  runner: Runner,
  ctx: RunnerContext,
  deps: {
    readonly processService: ProcessService
    readonly clock: Clock
  },
): Promise<RunnerResult> {
  const startedAt = deps.clock.now()
  const cmd = runner.buildCommand(ctx)
  const handle = deps.processService.spawn({ argv: cmd.argv, env: cmd.env, cwd: ctx.cwd })

  // Drain stderr concurrently to prevent pipe deadlock.
  const stderrDone = drainStream(handle.stderr)

  const events: RunnerEvent[] = []
  let finalEvent: TerminalEvent | null = null

  for await (const line of handle.stdout) {
    if (finalEvent !== null) continue // drain trailing output without processing
    const evt = runner.parseEvents(line)
    if (evt === null) continue
    events.push(evt)
    if (isTerminalEvent(evt)) {
      finalEvent = evt
    }
  }

  const { exitCode } = await handle.wait()
  await stderrDone
  const durationMs = deps.clock.now() - startedAt

  if (finalEvent === null) {
    finalEvent = {
      kind: 'terminal',
      type: 'error',
      message: `runner "${runner.name}" produced no terminal event`,
    }
  }

  return { events, finalEvent, exitCode, durationMs, structuredOutput: undefined }
}

async function drainStream(stream: AsyncIterable<string>): Promise<void> {
  for await (const _ of stream) {
    /* discard */
  }
}
