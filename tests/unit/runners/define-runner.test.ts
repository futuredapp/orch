import { describe, expect, it } from 'bun:test'
import {
  defineRunner,
  type InfoEvent,
  isTerminalEvent,
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
