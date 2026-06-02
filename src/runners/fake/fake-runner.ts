import type { ClassifiedError, ErrorCategory } from '../../core/recovery/index.ts'
import { isFailFast } from '../../core/recovery/index.ts'
import type { ViewDefault } from '../../core/view.ts'
import type { FakeProcessService } from '../../services/process/fake-process-service.ts'
import type {
  AutoStopPreparation,
  CaptureHandle,
  CaptureSessionIdContext,
  ClassifyErrorSignal,
  ForkResumeContext,
  InfoEvent,
  ProgressContext,
  Runner,
  RunnerCommand,
  RunnerContext,
  RunnerEvent,
  TerminalEvent,
  TranscriptLine,
} from '../types.ts'

/** Construction-time knobs that toggle optional capabilities on/off so tests
 *  can exercise both the supported and unsupported code paths. */
export interface FakeRunnerOptions {
  /** When `false`, the `prepareAutoStop` method is omitted entirely so the
   *  `typeof === 'function'` capability check reports the runner as
   *  auto-stop-unsupported. Defaults to `true`. */
  readonly supportsAutoStop?: boolean
}

export interface FakeScript {
  readonly events?: readonly InfoEvent[]
  readonly structuredOutput?: unknown
  readonly failWith?: { readonly message: string; readonly exitCode?: number }
  /**
   * When set, the script prepends a synthetic `session-started` info event
   * with `payload: { sessionId }`. Mirrors the shape claude-runner /
   * codex-runner emit for system-init / thread.started lines so workflow
   * tests can drive the sessionId-capture path with a deterministic value.
   */
  readonly sessionId?: string
}

export class FakeRunner implements Runner {
  readonly name = 'fake'
  readonly supports = { interactive: true, structuredOutput: true } as const
  readonly defaultView: ViewDefault = { kind: 'transcript', pane: 'right' }

  #fps: FakeProcessService
  #nonce: string
  #scriptsEnqueued = 0
  #invocations = 0
  #resumeArgvBuilder?: (sessionId: string) => readonly string[]
  #captureImpl?: (ctx: CaptureSessionIdContext) => CaptureHandle
  #classifyImpl?: (signal: ClassifyErrorSignal) => ClassifiedError
  #forkArgvBuilder?: (checkpointSessionId: string, nudge: string) => readonly string[]
  #progressImpl?: (event: RunnerEvent, ctx: ProgressContext) => boolean
  readonly #supportsAutoStop: boolean

  constructor(processService: FakeProcessService, opts: FakeRunnerOptions = {}) {
    this.#fps = processService
    this.#nonce = `f-${Math.random().toString(36).slice(2, 6)}`
    this.#supportsAutoStop = opts.supportsAutoStop ?? true
  }

  script(s: FakeScript): this {
    const lines: string[] = []

    if (s.sessionId !== undefined) {
      const synthetic: InfoEvent = {
        kind: 'info',
        type: 'session-started',
        payload: { sessionId: s.sessionId },
      }
      lines.push(JSON.stringify(synthetic))
    }

    for (const evt of s.events ?? []) {
      lines.push(JSON.stringify(evt))
    }

    if (s.failWith) {
      const terminal: TerminalEvent = {
        kind: 'terminal',
        type: 'error',
        message: s.failWith.message,
      }
      lines.push(JSON.stringify(terminal))
    } else {
      const terminal: TerminalEvent = {
        kind: 'terminal',
        type: 'turn-complete',
        data: s.structuredOutput,
      }
      lines.push(JSON.stringify(terminal))
    }

    const exit = s.failWith ? (s.failWith.exitCode ?? 1) : 0
    this.#fps.when([':fake:', this.#nonce]).respondWith({ stdout: lines, exitCode: exit })
    this.#scriptsEnqueued++
    return this
  }

  get invocationCount(): number {
    return this.#invocations
  }

  /** The argv every invocation (initial + forked) spawns under. Recovery tests
   *  point a resume-in-place builder at this so the scripted `FakeProcessService`
   *  queue drains in order across attempts. */
  get spawnArgv(): readonly string[] {
    return [':fake:', this.#nonce]
  }

  buildCommand(ctx: RunnerContext): RunnerCommand {
    if (this.#invocations >= this.#scriptsEnqueued) {
      throw new Error(
        `FakeRunner(${this.#nonce}): no script configured for invocation ${this.#invocations}`,
      )
    }
    this.#invocations++
    return { argv: [':fake:', this.#nonce], env: ctx.env }
  }

  parseEvents(line: string): RunnerEvent | null {
    if (line.trim() === '') return null
    return JSON.parse(line) as RunnerEvent
  }

  extractStructuredOutput(finalEvent: TerminalEvent): unknown {
    return (finalEvent as { data?: unknown }).data
  }

  toTranscriptLines(event: RunnerEvent): readonly TranscriptLine[] {
    if (event.kind === 'terminal' && event.type === 'error') {
      return [{ kind: 'block', heading: 'failed', rows: [['error', event.message]] }]
    }
    if (event.kind === 'info') {
      // Test scripts hand-roll events like
      //   { kind: 'info', type: 'assistant', payload: { text: 'hi' } }
      // Surface a `text` payload as an assistant line so view-resolution and
      // host-output integration tests can assert `[step] …` shows up.
      const payload = event.payload as { readonly text?: unknown } | undefined
      if (payload !== undefined && typeof payload.text === 'string' && payload.text.length > 0) {
        return [{ kind: 'line', category: 'assistant', label: 'assistant>', body: payload.text }]
      }
    }
    return []
  }

  /**
   * Configure the argv `resumeCommand` will return. Calling this enables the
   * `resumeCommand` method (the slot is `undefined` until set, mirroring
   * runners that lack a resume primitive). Default builder produces
   *   `[':fake-resume:', <nonce>, <sessionId>]`
   * — opaque on purpose so test assertions don't accidentally couple to a
   * realistic CLI shape.
   */
  withResumeCommand(builder?: (sessionId: string) => readonly string[]): this {
    this.#resumeArgvBuilder =
      builder ?? ((sessionId: string) => [':fake-resume:', this.#nonce, sessionId])
    return this
  }

  get resumeCommand(): Runner['resumeCommand'] {
    if (this.#resumeArgvBuilder === undefined) return undefined
    const builder = this.#resumeArgvBuilder
    return (ctx: RunnerContext, sessionId: string): RunnerCommand => ({
      argv: builder(sessionId),
      env: ctx.env,
    })
  }

  /**
   * Configure the implementation `captureSessionId` will return. Calling this
   * enables the `captureSessionId` method (the slot is `undefined` until set,
   * mirroring runners that lack a capture primitive — Claude today). Default
   * implementation resolves `snapshotReady` and `result` immediately with
   * `{ sessionId: 'fake-session-<nonce>' }` so cooperative `await snapshotReady
   * → spawn → await result` flows don't hang in tests that don't care about
   * timing.
   */
  withCaptureSessionId(impl?: (ctx: CaptureSessionIdContext) => CaptureHandle): this {
    if (impl !== undefined) {
      this.#captureImpl = impl
      return this
    }
    const sessionId = `fake-session-${this.#nonce}`
    this.#captureImpl = () => ({
      snapshotReady: Promise.resolve(),
      result: Promise.resolve({ sessionId }),
    })
    return this
  }

  get captureSessionId(): Runner['captureSessionId'] {
    if (this.#captureImpl === undefined) return undefined
    const impl = this.#captureImpl
    return (ctx: CaptureSessionIdContext): CaptureHandle => impl(ctx)
  }

  /**
   * Present by default so interactive auto-stop tests get a supporting runner
   * for free. Omitted when constructed with `{ supportsAutoStop: false }` so
   * the executor's fail-fast (`AutoStopUnsupportedError`) path is exercisable.
   * The no-op preparation adds no env and its cleanup is a true no-op — the
   * FakeRunner has no on-disk artifact to write or restore.
   */
  get prepareAutoStop(): Runner['prepareAutoStop'] {
    if (!this.#supportsAutoStop) return undefined
    return async (): Promise<AutoStopPreparation> => ({ env: {}, cleanup: async () => {} })
  }

  // -------------------------------------------------------------------------
  // Recovery capabilities (U7) — presence-as-capability, off until a builder
  // enables them, mirroring `withResumeCommand` / `withCaptureSessionId`.
  // -------------------------------------------------------------------------

  /**
   * Enable `classifyError`. The default classifier reads the terminal error
   * message: a message that NAMES an {@link ErrorCategory} (e.g. `'auth'`,
   * `'overload'`) classifies as that category — so a test drives the strategy
   * by what it scripts in `failWith.message`. Anything else is `overload`
   * (the common retryable case). Pass a custom fn for full control.
   */
  withClassifyError(impl?: (signal: ClassifyErrorSignal) => ClassifiedError): this {
    this.#classifyImpl = impl ?? defaultFakeClassify
    return this
  }

  get classifyError(): Runner['classifyError'] {
    if (this.#classifyImpl === undefined) return undefined
    const impl = this.#classifyImpl
    return (signal: ClassifyErrorSignal): ClassifiedError => impl(signal)
  }

  /**
   * Enable `forkResumeCommand`. The default builder returns the SAME argv as
   * `buildCommand` (`[':fake:', nonce]`) so each forked attempt drains the
   * next queued `script(...)` response in order — that is how a test sequences
   * error → fork → progress → complete across attempts. Pass a builder to
   * assert a distinct fork argv.
   */
  withForkResumeCommand(
    builder?: (checkpointSessionId: string, nudge: string) => readonly string[],
  ): this {
    this.#forkArgvBuilder = builder ?? (() => [':fake:', this.#nonce])
    return this
  }

  get forkResumeCommand(): Runner['forkResumeCommand'] {
    if (this.#forkArgvBuilder === undefined) return undefined
    const builder = this.#forkArgvBuilder
    return (ctx: ForkResumeContext, checkpointSessionId: string, nudge: string): RunnerCommand => ({
      argv: builder(checkpointSessionId, nudge),
      env: ctx.env,
    })
  }

  /**
   * Enable `isProgressEvent`. The default predicate counts an `assistant` info
   * event after resume as progress (the Claude-shaped happy path); pre-resume
   * events never count. Pass a custom predicate for other shapes.
   */
  withProgressEvent(impl?: (event: RunnerEvent, ctx: ProgressContext) => boolean): this {
    this.#progressImpl = impl ?? defaultFakeProgress
    return this
  }

  get isProgressEvent(): Runner['isProgressEvent'] {
    if (this.#progressImpl === undefined) return undefined
    const impl = this.#progressImpl
    return (event: RunnerEvent, ctx: ProgressContext): boolean => impl(event, ctx)
  }
}

const KNOWN_CATEGORIES: readonly ErrorCategory[] = [
  'overload',
  'server_error',
  'rate_limit',
  'usage_limit',
  'auth',
  'billing',
  'invalid_request',
  'model_not_found',
  'unknown',
]

function defaultFakeClassify(signal: ClassifyErrorSignal): ClassifiedError {
  const message = signal.finalEvent.type === 'error' ? signal.finalEvent.message : ''
  const named = KNOWN_CATEGORIES.find((c) => message.includes(c))
  const category = named ?? 'overload'
  return { category, transient: !isFailFast(category) }
}

function defaultFakeProgress(event: RunnerEvent, ctx: ProgressContext): boolean {
  if (!ctx.sinceResume) return false
  return event.kind === 'info' && event.type === 'assistant'
}
