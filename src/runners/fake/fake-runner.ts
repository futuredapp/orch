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

  script(_s: FakeScript): this {
    throw new Error('not implemented')
  }

  get invocationCount(): number {
    throw new Error('not implemented')
  }

  buildCommand(_ctx: RunnerContext): RunnerCommand {
    throw new Error('not implemented')
  }

  parseEvents(_line: string): RunnerEvent | null {
    throw new Error('not implemented')
  }

  extractStructuredOutput(_finalEvent: TerminalEvent): unknown {
    throw new Error('not implemented')
  }
}
