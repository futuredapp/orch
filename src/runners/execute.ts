import type { Clock, ProcessService } from '../services/index.ts'
import type { Runner, RunnerContext, TerminalEvent } from './types.ts'
import { isTerminalEvent } from './types.ts'

export interface RunnerResult {
  readonly finalEvent: TerminalEvent
  readonly exitCode: number
  readonly durationMs: number
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

  let finalEvent: TerminalEvent | null = null
  let exitCode: number

  try {
    for await (const line of handle.stdout) {
      if (finalEvent !== null) continue // drain trailing output without processing
      const evt = runner.parseEvents(line)
      if (evt === null) continue
      if (isTerminalEvent(evt)) {
        finalEvent = evt
      }
    }

    const waitResult = await handle.wait()
    exitCode = waitResult.exitCode
    await stderrDone
  } finally {
    // Guarantee subprocess cleanup on every throw path. kill() is a safe
    // no-op once the process has already exited (verified in
    // bun-process-service.ts and fake-process-service.ts); swallow any
    // error it may throw so it cannot mask the original failure.
    try {
      handle.kill()
    } catch {
      /* subprocess already gone */
    }
  }

  const durationMs = deps.clock.now() - startedAt

  if (finalEvent === null) {
    finalEvent = {
      kind: 'terminal',
      type: 'error',
      message: `runner "${runner.name}" produced no terminal event`,
    }
  }

  return { finalEvent, exitCode, durationMs }
}

async function drainStream(stream: AsyncIterable<string>): Promise<void> {
  for await (const _ of stream) {
    /* discard */
  }
}
