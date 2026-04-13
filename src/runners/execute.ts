import type { Clock, ProcessHandle, ProcessService } from '../services/index.ts'
import type { Runner, RunnerContext, TerminalEvent } from './types.ts'
import { isTerminalEvent } from './types.ts'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Safe kill — no-op when the process has already exited.
 * Shared by runRunner and runInteractive.
 */
function safeKill(handle: ProcessHandle): void {
  try {
    handle.kill()
  } catch {
    /* subprocess already gone */
  }
}

// ---------------------------------------------------------------------------
// runRunner — autonomous execution with NDJSON parsing
// ---------------------------------------------------------------------------

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
  const cmd = await runner.buildCommand(ctx)
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
    safeKill(handle)
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

// ---------------------------------------------------------------------------
// runInteractive — foreground execution, no NDJSON parsing
// ---------------------------------------------------------------------------

export interface InteractiveRunResult {
  readonly exitCode: number
  readonly durationMs: number
}

export async function runInteractive(
  runner: Runner,
  ctx: RunnerContext,
  deps: {
    readonly processService: ProcessService
    readonly clock: Clock
  },
): Promise<InteractiveRunResult> {
  const startedAt = deps.clock.now()
  const cmd = await runner.buildCommand({ ...ctx, mode: 'interactive' })
  const handle = deps.processService.spawnForeground({
    argv: cmd.argv,
    env: cmd.env,
    cwd: ctx.cwd,
  })

  try {
    const { exitCode } = await handle.wait()
    const durationMs = deps.clock.now() - startedAt
    return { exitCode, durationMs }
  } finally {
    safeKill(handle)
  }
}
