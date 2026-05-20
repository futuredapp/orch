import type { ViewDefault } from '../../core/view.ts'
import type { FakeProcessService } from '../../services/process/fake-process-service.ts'
import type {
  CaptureHandle,
  CaptureSessionIdContext,
  InfoEvent,
  Runner,
  RunnerCommand,
  RunnerContext,
  RunnerEvent,
  TerminalEvent,
  TranscriptLine,
} from '../types.ts'

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

  constructor(processService: FakeProcessService) {
    this.#fps = processService
    this.#nonce = `f-${Math.random().toString(36).slice(2, 6)}`
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
}
