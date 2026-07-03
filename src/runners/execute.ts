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
  /**
   * A bounded tail of the lines drained from the subprocess's stderr. Retained
   * so a runner that dies at startup (before emitting any stdout JSON) surfaces
   * *why* — the tail is folded into the synthesized no-terminal-event error and
   * threaded into the classify signal. Capped at {@link STDERR_TAIL_MAX_CHARS}
   * (most-recent-wins) so a runaway stderr cannot blow memory.
   */
  readonly stderr: string
}

/** Memory cap for the retained stderr tail (most-recent lines win). */
const STDERR_TAIL_MAX_CHARS = 8 * 1024

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

  // Drain stderr concurrently to prevent pipe deadlock. Every line is also
  // retained into a bounded tail (so a startup crash surfaces its reason) and,
  // under `--debug`, forwarded to the raw-line hook. Swallow drain errors
  // (including the abort unwind) so they never surface as unhandled rejections.
  const stderrTail = makeBoundedTail(STDERR_TAIL_MAX_CHARS)
  const stderrDone = drainStream(handle.stderr, (line) => {
    stderrTail.push(line)
    deps.onRawLine?.('stderr', line)
  }).catch(() => {})

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

  // Await the drain on both the normal and AbortError paths so the retained tail
  // is fully flushed before it is read. `safeKill` in `finally` above closes the
  // pipe first, so a killed child's stderr stream still terminates the drain.
  // `stderrDone` is `.catch`-guarded, so this await never rejects.
  await stderrDone

  const durationMs = deps.clock.now() - startedAt
  const stderr = stderrTail.value()

  if (finalEvent === null) {
    // A runner that dies before emitting any terminal event is structurally a
    // launch/config crash. Fold the stderr tail into the message so the real
    // reason ("Error loading rules: …") is legible everywhere downstream — the
    // pane, the StepError, and the classifier.
    const base = `runner "${runner.name}" produced no terminal event`
    const tail = stderr.trim()
    finalEvent = {
      kind: 'terminal',
      type: 'error',
      message: tail.length > 0 ? `${base}\n${tail}` : base,
    }
  }

  return { finalEvent, exitCode, durationMs, stderr }
}

/**
 * A most-recent-wins line buffer that never retains more than `maxChars` worth
 * of text. Keeps at least the last line even when it alone exceeds the cap, so a
 * single runaway line still surfaces its tail rather than vanishing.
 */
function makeBoundedTail(maxChars: number): {
  push(line: string): void
  value(): string
} {
  const lines: string[] = []
  let chars = 0
  return {
    push(line: string): void {
      lines.push(line)
      chars += line.length + 1
      while (chars > maxChars && lines.length > 1) {
        const dropped = lines.shift()
        if (dropped !== undefined) chars -= dropped.length + 1
      }
    },
    value(): string {
      return lines.join('\n')
    },
  }
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
