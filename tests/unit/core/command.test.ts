import { describe, expect, it } from 'bun:test'
import {
  type CommandResult,
  CommandResultSchema,
  command,
  tail,
} from '../../../src/core/command.ts'
import { onCacheHit } from '../../../src/core/step.ts'
import { stepName } from '../../../src/core/types.ts'

// ---------------------------------------------------------------------------
// Factory validation
// ---------------------------------------------------------------------------

describe('command() factory — name validation', () => {
  it('rejects an empty step name', () => {
    expect(() => command('', { argv: ['true'], onFailure: 'halt' })).toThrow()
  })

  it('rejects a whitespace-only step name', () => {
    expect(() => command('   ', { argv: ['true'], onFailure: 'halt' })).toThrow()
  })

  it('rejects a step name that begins with the reserved "command:" prefix', () => {
    expect(() => command('command:explicit', { argv: ['true'], onFailure: 'halt' })).toThrow(
      /reserved/,
    )
  })

  it('rejects a name that slugifies to more than 120 characters', () => {
    // 128 total - 'command:'.length (8) = 120 slug chars
    const slug121 = 'a'.repeat(121)

    expect(() => command(slug121, { argv: ['true'], onFailure: 'halt' })).toThrow()
  })

  it('accepts a name that slugifies to exactly 120 characters', () => {
    const slug120 = 'a'.repeat(120)

    const s = command(slug120, { argv: ['true'], onFailure: 'halt' })

    expect(s.name as string).toBe(`command:${slug120}`)
  })

  it('rejects a name that slugifies to empty (all punctuation)', () => {
    expect(() => command('!!!', { argv: ['true'], onFailure: 'halt' })).toThrow(/empty slug/)
  })

  it('derives the step name as "command:<slug>" from the input name', () => {
    const s = command('Run Tests', { argv: ['bun', 'test'], onFailure: 'continue' })

    expect(s.name as string).toBe('command:run-tests')
  })

  it('strips leading/trailing non-alphanumeric characters from the slug', () => {
    const s = command('--tests--', { argv: ['true'], onFailure: 'halt' })

    expect(s.name as string).toBe('command:tests')
  })

  it('lowercases the slug', () => {
    const s = command('TESTS', { argv: ['true'], onFailure: 'halt' })

    expect(s.name as string).toBe('command:tests')
  })
})

describe('command() factory — argv validation', () => {
  it('rejects argv that is empty', () => {
    expect(() => command('tests', { argv: [], onFailure: 'halt' })).toThrow(/empty/)
  })

  it('rejects argv whose first element is the empty string', () => {
    expect(() => command('tests', { argv: [''], onFailure: 'halt' })).toThrow()
  })

  it('rejects argv whose first element contains a null byte', () => {
    expect(() => command('tests', { argv: ['ev\0il'], onFailure: 'halt' })).toThrow(/null/)
  })

  it('rejects argv whose first element contains a newline', () => {
    expect(() => command('tests', { argv: ['ev\nil'], onFailure: 'halt' })).toThrow(/newline/)
  })

  it('rejects subsequent argv elements containing a null byte', () => {
    expect(() => command('tests', { argv: ['true', 'ev\0il'], onFailure: 'halt' })).toThrow(/null/)
  })
})

describe('command() factory — onFailure validation', () => {
  it('rejects an unknown onFailure value', () => {
    expect(() =>
      command('tests', {
        argv: ['true'],
        // biome-ignore lint/suspicious/noExplicitAny: testing invalid input
        onFailure: 'maybe' as any,
      }),
    ).toThrow(/onFailure/)
  })

  it('requires onFailure — undefined throws', () => {
    expect(() =>
      command('tests', {
        argv: ['true'],
        // biome-ignore lint/suspicious/noExplicitAny: testing invalid input
        onFailure: undefined as any,
      }),
    ).toThrow(/onFailure/)
  })

  it("accepts onFailure: 'halt'", () => {
    const s = command('tests', { argv: ['true'], onFailure: 'halt' })

    if (s.config.kind !== 'command') throw new Error('expected command config')
    expect(s.config.onFailure).toBe('halt')
  })

  it("accepts onFailure: 'continue'", () => {
    const s = command('tests', { argv: ['true'], onFailure: 'continue' })

    if (s.config.kind !== 'command') throw new Error('expected command config')
    expect(s.config.onFailure).toBe('continue')
  })
})

describe('command() factory — env / cwd / pane validation', () => {
  it('rejects env values containing null bytes', () => {
    expect(() =>
      command('tests', { argv: ['true'], onFailure: 'halt', env: { K: 'a\0b' } }),
    ).toThrow(/null/)
  })

  it('rejects env values containing newlines', () => {
    expect(() =>
      command('tests', { argv: ['true'], onFailure: 'halt', env: { K: 'a\nb' } }),
    ).toThrow(/newline/)
  })
})

describe('command() factory — Step shape', () => {
  it('returns a frozen Step', () => {
    const s = command('freeze', { argv: ['true'], onFailure: 'halt' })

    expect(Object.isFrozen(s)).toBe(true)
  })

  it('produces config.kind === "command"', () => {
    const s = command('tests', { argv: ['true'], onFailure: 'halt' })

    expect(s.config.kind).toBe('command')
  })

  it('preserves argv verbatim in config', () => {
    const s = command('tests', { argv: ['bun', 'test', '--coverage'], onFailure: 'continue' })

    if (s.config.kind !== 'command') throw new Error('expected command config')
    expect([...s.config.argv]).toEqual(['bun', 'test', '--coverage'])
  })
})

// ---------------------------------------------------------------------------
// CommandResultSchema (Zod)
// ---------------------------------------------------------------------------

describe('CommandResultSchema', () => {
  it('accepts a well-formed CommandResult', () => {
    const parsed = CommandResultSchema.safeParse({
      exitCode: 0,
      stdout: 'hello\n',
      stderr: '',
      durationMs: 42,
    })

    expect(parsed.success).toBe(true)
  })

  it('rejects a CommandResult with a non-integer exitCode', () => {
    const parsed = CommandResultSchema.safeParse({
      exitCode: 0.5,
      stdout: '',
      stderr: '',
      durationMs: 0,
    })

    expect(parsed.success).toBe(false)
  })

  it('rejects a CommandResult with a negative durationMs', () => {
    const parsed = CommandResultSchema.safeParse({
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: -1,
    })

    expect(parsed.success).toBe(false)
  })

  it('rejects a CommandResult with a non-string stdout', () => {
    const parsed = CommandResultSchema.safeParse({
      exitCode: 0,
      stdout: 42,
      stderr: '',
      durationMs: 0,
    })

    expect(parsed.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// onCacheHit branch for 'command'
// ---------------------------------------------------------------------------

describe('onCacheHit — command kind', () => {
  it('succeeds for a well-formed cached value', () => {
    const value: CommandResult = { exitCode: 0, stdout: 'a\n', stderr: '', durationMs: 1 }

    expect(() =>
      onCacheHit(
        { kind: 'command', argv: ['true'], onFailure: 'halt' },
        stepName('command:tests'),
        value,
      ),
    ).not.toThrow()
  })

  it('throws for a malformed cached value', () => {
    expect(() =>
      onCacheHit(
        { kind: 'command', argv: ['true'], onFailure: 'halt' },
        stepName('command:tests'),
        { foo: 'bar' },
      ),
    ).toThrow(/malformed/)
  })

  it('does not re-execute the command (no side effects)', () => {
    // Safety net: no spawn happens during cache replay. We don't pass
    // any spawn-capable services — the call would crash if it tried to.
    const value: CommandResult = { exitCode: 0, stdout: '', stderr: '', durationMs: 0 }

    onCacheHit(
      { kind: 'command', argv: ['nope'], onFailure: 'halt' },
      stepName('command:noop'),
      value,
    )
  })
})

// ---------------------------------------------------------------------------
// tail()
// ---------------------------------------------------------------------------

describe('tail()', () => {
  it('returns the entire string when n exceeds the line count', () => {
    expect(tail('a\nb\nc\n', 10)).toBe('a\nb\nc\n')
  })

  it('returns the empty string when n is 0', () => {
    expect(tail('a\nb\nc\n', 0)).toBe('')
  })

  it('returns the empty string when n is negative', () => {
    expect(tail('a\nb\nc\n', -3)).toBe('')
  })

  it('preserves a trailing newline', () => {
    expect(tail('a\nb\nc\nd\n', 2)).toBe('c\nd\n')
  })

  it('omits a trailing newline when the input had none', () => {
    expect(tail('a\nb\nc\nd', 2)).toBe('c\nd')
  })

  it('handles a string with no newlines', () => {
    expect(tail('single', 5)).toBe('single')
  })

  it('handles an empty string', () => {
    expect(tail('', 5)).toBe('')
  })

  it('handles CRLF line endings (preserves \\r inside retained lines)', () => {
    // Each line keeps its trailing \r; only the final \n triggers the split.
    expect(tail('a\r\nb\r\nc\r\n', 2)).toBe('b\r\nc\r\n')
  })
})
