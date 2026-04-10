import type { FakeProcessService } from '../../services/process/fake-process-service.ts'
import type {
  InfoEvent,
  Runner,
  RunnerCommand,
  RunnerContext,
  RunnerEvent,
  TerminalEvent,
} from '../types.ts'

export interface FakeScript {
  readonly events?: readonly InfoEvent[]
  readonly structuredOutput?: unknown
  readonly failWith?: { readonly message: string; readonly exitCode?: number }
}

export class FakeRunner implements Runner {
  readonly name = 'fake'
  readonly supports = { interactive: true, structuredOutput: true } as const

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
    this.#fps.when([':fake:', this.#nonce]).respondWith({ stdout: lines, exit })
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
}
