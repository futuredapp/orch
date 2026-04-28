import type { ViewDefault } from '../../core/view.ts'
import type { FakeProcessService } from '../../services/process/fake-process-service.ts'
import type {
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
}

export class FakeRunner implements Runner {
  readonly name = 'fake'
  readonly supports = { interactive: true, structuredOutput: true } as const
  readonly defaultView: ViewDefault = { kind: 'transcript', pane: 'right' }

  #fps: FakeProcessService
  #nonce: string
  #scriptsEnqueued = 0
  #invocations = 0

  constructor(processService: FakeProcessService) {
    this.#fps = processService
    this.#nonce = `f-${Math.random().toString(36).slice(2, 6)}`
  }

  script(s: FakeScript): this {
    const lines: string[] = []

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
}
