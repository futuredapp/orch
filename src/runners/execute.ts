import type { Clock, ProcessHandle, ProcessService } from '../services/index.ts'
import type { Runner, RunnerCommand, RunnerContext, RunnerEvent, TerminalEvent } from './types.ts'
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

/** True for the `AbortError` an aborted stream iterator raises. */
function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
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
    /**
     * Agent-native hook: fires for every RunnerEvent parsed from stdout
     * (terminal + info). Used by observe mode to tee the event stream.
     */
    readonly onEvent?: (event: RunnerEvent) => void
    /**
     * `--debug` capture seam. Fires for every raw line drained from stdout
     * or stderr before any parsing. Under `!debug`, this is undefined —
     * zero overhead for the hot path. Raw lines preserve parser misses and
     * NDJSON decode failures; `onEvent` only sees what `parseEvents`
     * accepts. See plan § Phase 3.
     */
    readonly onRawLine?: (stream: 'stdout' | 'stderr', line: string) => void
    /**
     * Recovery (U7): abort the spawn when the loop's per-attempt stall
     * watchdog (or the wall-clock cap) fires. On abort the handle is killed,
     * the stdout iterator unwinds, and `runRunner` synthesizes a terminal
     * error rather than crashing — so a hung fork can never hold the run
     * open indefinitely.
     */
    readonly signal?: AbortSignal
    /**
     * Recovery (U7): a prebuilt command that overrides `runner.buildCommand`.
     * The fork-resume path builds its argv via `runner.forkResumeCommand`
     * (Claude `--fork-session`, Codex rollout-copy) and hands it here, so the
     * runner re-uses the same spawn/parse machinery for every attempt.
     */
    readonly command?: RunnerCommand
  },
): Promise<RunnerResult> {
  const startedAt = deps.clock.now()
  const cmd = deps.command ?? (await runner.buildCommand(ctx))
  const handle = deps.processService.spawn({
    argv: cmd.argv,
    env: cmd.env,
    cwd: ctx.cwd,
    tag: 'agent',
  })

  // Abort wiring (U7): killing the handle unwinds the stdout/stderr iterators.
  // `once` + explicit removal in `finally` keeps the listener from leaking
  // across the many attempts a recovery loop drives through one signal.
  const onAbort = (): void => safeKill(handle)
  if (deps.signal !== undefined) {
    if (deps.signal.aborted) safeKill(handle)
    else deps.signal.addEventListener('abort', onAbort, { once: true })
  }

  // Drain stderr concurrently to prevent pipe deadlock. Under `--debug` the
  // raw-line hook also fires on every stderr line. Swallow drain errors
  // (including the abort unwind) so they never surface as unhandled rejections.
  const stderrDone = drainStream(handle.stderr, (line) => deps.onRawLine?.('stderr', line)).catch(
    () => {},
  )

  let finalEvent: TerminalEvent | null = null
  let exitCode: number

  try {
    for await (const line of handle.stdout) {
      deps.onRawLine?.('stdout', line)
      if (finalEvent !== null) continue // drain trailing output without processing
      const evt = runner.parseEvents(line)
      if (evt === null) continue
      deps.onEvent?.(evt)
      if (isTerminalEvent(evt)) {
        finalEvent = evt
      }
    }

    const waitResult = await handle.wait()
    exitCode = waitResult.exitCode
    await stderrDone
  } catch (err) {
    // An aborted attempt (watchdog/cap kill) unwinds the iterator with an
    // `AbortError`. Treat it as "no terminal event" — the synthesized error
    // below lets the recovery loop re-enter the verdict. Anything else is a
    // genuine fault and propagates.
    if (!isAbortError(err)) throw err
    exitCode = -1
  } finally {
    if (deps.signal !== undefined) deps.signal.removeEventListener('abort', onAbort)
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

async function drainStream(
  stream: AsyncIterable<string>,
  onLine?: (line: string) => void,
): Promise<void> {
  for await (const line of stream) {
    onLine?.(line)
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
