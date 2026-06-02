import { describe, expect, it } from 'bun:test'
import type { ClassifiedError } from '../../../src/core/recovery/index.ts'
import {
  type ClassifyErrorSignal,
  defineRunner,
  type ForkResumeContext,
  type InfoEvent,
  isTerminalEvent,
  type ProgressContext,
  type Runner,
  type RunnerCommand,
  type RunnerContext,
  type RunnerEvent,
  type TerminalEvent,
} from '../../../src/runners/index.ts'

function makeValidAdapter(): Runner {
  return {
    name: 'test-adapter',
    supports: { interactive: false, structuredOutput: true },
    buildCommand(_ctx: RunnerContext): RunnerCommand {
      return { argv: ['test'], env: {} }
    },
    parseEvents(_line: string): RunnerEvent | null {
      return null
    },
    extractStructuredOutput(_finalEvent: TerminalEvent): unknown {
      return undefined
    },
    toTranscriptLines() {
      return []
    },
  }
}

describe('defineRunner', () => {
  it('accepts a valid adapter and returns a frozen copy', () => {
    const adapter = makeValidAdapter()

    const result = defineRunner(adapter)

    expect(result.name).toBe('test-adapter')
    expect(Object.isFrozen(result)).toBe(true)
  })

  it('throws a readable error when name is missing', () => {
    const adapter = makeValidAdapter()
    const { name: _, ...noName } = adapter

    expect(() => defineRunner(noName as unknown as Runner)).toThrow(/name/)
  })

  it('throws a readable error when supports is missing', () => {
    const adapter = makeValidAdapter()
    const { supports: _, ...noSupports } = adapter

    expect(() => defineRunner(noSupports as unknown as Runner)).toThrow(/supports/)
  })

  it('throws a readable error when buildCommand is missing', () => {
    const adapter = makeValidAdapter()
    const { buildCommand: _, ...noBuildCommand } = adapter

    expect(() => defineRunner(noBuildCommand as unknown as Runner)).toThrow(/buildCommand/)
  })

  it('throws a readable error when parseEvents is missing', () => {
    const adapter = makeValidAdapter()
    const { parseEvents: _, ...noParseEvents } = adapter

    expect(() => defineRunner(noParseEvents as unknown as Runner)).toThrow(/parseEvents/)
  })

  it('throws a readable error when extractStructuredOutput is missing', () => {
    const adapter = makeValidAdapter()
    const { extractStructuredOutput: _, ...noExtract } = adapter

    expect(() => defineRunner(noExtract as unknown as Runner)).toThrow(/extractStructuredOutput/)
  })

  it('throws a readable error when toTranscriptLines is missing', () => {
    const adapter = makeValidAdapter()
    const { toTranscriptLines: _, ...noFormatter } = adapter

    expect(() => defineRunner(noFormatter as unknown as Runner)).toThrow(/toTranscriptLines/)
  })

  it('does not leak config values in error messages', () => {
    const partial = { name: 'secret-runner-KEY_12345' } as unknown as Runner

    try {
      defineRunner(partial)
    } catch (err) {
      const msg = (err as Error).message
      expect(msg).not.toContain('KEY_12345')
    }
  })
})

function withRecoveryCapabilities(): Runner {
  return {
    ...makeValidAdapter(),
    classifyError(_signal: ClassifyErrorSignal): ClassifiedError {
      return { category: 'overload', transient: true, httpStatus: 529 }
    },
    forkResumeCommand(_ctx: ForkResumeContext, _checkpoint: string, _nudge: string): RunnerCommand {
      return { argv: ['test', '--fork-session'], env: {} }
    },
    isProgressEvent(_event: RunnerEvent, _ctx: ProgressContext): boolean {
      return false
    },
  }
}

describe('defineRunner recovery capabilities', () => {
  it('accepts an adapter that declares all three recovery methods', () => {
    const adapter = withRecoveryCapabilities()

    const result = defineRunner(adapter)

    expect(typeof result.classifyError).toBe('function')
    expect(typeof result.forkResumeCommand).toBe('function')
    expect(typeof result.isProgressEvent).toBe('function')
  })

  it('accepts an adapter declaring none of them and reads as capability-absent via typeof', () => {
    const adapter = makeValidAdapter()

    const result = defineRunner(adapter)

    expect(typeof result.classifyError).toBe('undefined')
    expect(typeof result.forkResumeCommand).toBe('undefined')
    expect(typeof result.isProgressEvent).toBe('undefined')
  })

  it('rejects a malformed (non-function) classifyError', () => {
    const adapter = { ...makeValidAdapter(), classifyError: 'nope' } as unknown as Runner

    expect(() => defineRunner(adapter)).toThrow(/classifyError/)
  })
})

describe('isTerminalEvent', () => {
  it('narrows a turn-complete event to TerminalEvent', () => {
    const evt: RunnerEvent = { kind: 'terminal', type: 'turn-complete' }

    expect(isTerminalEvent(evt)).toBe(true)

    if (isTerminalEvent(evt)) {
      const _check: TerminalEvent = evt
    }
  })

  it('narrows an error event to TerminalEvent', () => {
    const evt: RunnerEvent = { kind: 'terminal', type: 'error', message: 'boom' }

    expect(isTerminalEvent(evt)).toBe(true)

    if (isTerminalEvent(evt) && evt.type === 'error') {
      expect(evt.message).toBe('boom')
    }
  })

  it('returns false for an arbitrary info event', () => {
    const evt: InfoEvent = { kind: 'info', type: 'thinking' }

    expect(isTerminalEvent(evt)).toBe(false)
  })
})
