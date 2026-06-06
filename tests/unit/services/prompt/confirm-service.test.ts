// MIGRATED → tests-new/unit/services/prompt/confirm-service.test.ts (parent U12) — relocated verbatim (import paths only); kept skipped on disk (D2).
import { describe, expect, it } from 'bun:test'
import { PassThrough } from 'node:stream'
import {
  confirmSuffix,
  FakeConfirmService,
  parseYesNo,
  ReadlineConfirmService,
} from '../../../../src/services/prompt/index.ts'

describe.skip('parseYesNo', () => {
  it('returns the default when input is the empty string', () => {
    expect(parseYesNo('', true)).toBe(true)
    expect(parseYesNo('', false)).toBe(false)
  })

  it('returns the default when input is whitespace only', () => {
    expect(parseYesNo('   ', true)).toBe(true)
    expect(parseYesNo('\t', false)).toBe(false)
  })

  it('parses single-letter yes/no case-insensitively', () => {
    expect(parseYesNo('y', false)).toBe(true)
    expect(parseYesNo('Y', false)).toBe(true)
    expect(parseYesNo('n', true)).toBe(false)
    expect(parseYesNo('N', true)).toBe(false)
  })

  it('parses full-word yes/no case-insensitively', () => {
    expect(parseYesNo('yes', false)).toBe(true)
    expect(parseYesNo('YES', false)).toBe(true)
    expect(parseYesNo('no', true)).toBe(false)
    expect(parseYesNo('No', true)).toBe(false)
  })

  it('returns undefined on unrecognised input', () => {
    expect(parseYesNo('maybe', false)).toBeUndefined()
    expect(parseYesNo('yep', false)).toBeUndefined()
    expect(parseYesNo('1', false)).toBeUndefined()
  })
})

describe.skip('confirmSuffix', () => {
  it('uppercases the default side', () => {
    expect(confirmSuffix(true)).toBe('[Y/n]')
    expect(confirmSuffix(false)).toBe('[y/N]')
  })
})

describe.skip('ReadlineConfirmService', () => {
  // Deliver each scripted answer in response to a prompt write on the output
  // stream. Using `input.end()` up-front (or writing all lines as a batch)
  // races with readline's line-buffering on PassThrough; tying the response
  // to the prompt write keeps the cadence deterministic.
  function scriptedStreams(answers: ReadonlyArray<string>): {
    readonly input: PassThrough
    readonly output: PassThrough
    readonly outputText: () => string
  } {
    const input = new PassThrough()
    const output = new PassThrough()
    const chunks: string[] = []
    let idx = 0
    output.on('data', (c) => {
      const str = c.toString()
      chunks.push(str)
      if (/\[[YyNn]\/[yYnN]\]/.test(str) && idx < answers.length) {
        const next = answers[idx++]
        setImmediate(() => input.write(`${next}\n`))
      }
    })
    return { input, output, outputText: () => chunks.join('') }
  }

  it('returns true on "y" and writes the question with [y/N] suffix to the output stream', async () => {
    const { input, output, outputText } = scriptedStreams(['y'])
    const svc = new ReadlineConfirmService({ input, output })
    const answer = await svc.confirm('Replace it?', false)
    expect(answer).toBe(true)
    expect(outputText()).toContain('Replace it?')
    expect(outputText()).toContain('[y/N]')
  })

  it('returns false on "n"', async () => {
    const { input, output } = scriptedStreams(['n'])
    const svc = new ReadlineConfirmService({ input, output })
    expect(await svc.confirm('Replace it?', true)).toBe(false)
  })

  it('returns the default on empty input', async () => {
    const { input, output } = scriptedStreams([''])
    const svc = new ReadlineConfirmService({ input, output })
    expect(await svc.confirm('Keep workflows?', true)).toBe(true)
  })

  it('re-prompts on unrecognised input then accepts a valid answer', async () => {
    const { input, output, outputText } = scriptedStreams(['maybe', 'y'])
    const svc = new ReadlineConfirmService({ input, output })
    const answer = await svc.confirm('Proceed?', false)
    expect(answer).toBe(true)
    expect(outputText()).toContain('Please answer')
  })

  it('returns the default after 3 unrecognised attempts and warns', async () => {
    const { input, output, outputText } = scriptedStreams(['a', 'b', 'c'])
    const svc = new ReadlineConfirmService({ input, output })
    const answer = await svc.confirm('Proceed?', true)
    expect(answer).toBe(true)
    expect(outputText()).toContain('No valid answer after 3 attempts')
  })
})

describe.skip('FakeConfirmService', () => {
  it('returns scripted answers in FIFO order', async () => {
    const svc = new FakeConfirmService([true, false])
    expect(await svc.confirm('q1', false)).toBe(true)
    expect(await svc.confirm('q2', true)).toBe(false)
  })

  it('records each call with its question and default', async () => {
    const svc = new FakeConfirmService([true, false])
    await svc.confirm('first?', false)
    await svc.confirm('second?', true)
    const calls = svc.recorded()
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual({ question: 'first?', defaultAnswer: false })
    expect(calls[1]).toEqual({ question: 'second?', defaultAnswer: true })
  })

  it('throws a clear error when the scripted queue is exhausted', async () => {
    const svc = new FakeConfirmService([true])
    await svc.confirm('first?', false)
    await expect(svc.confirm('second?', false)).rejects.toThrow(
      /unscripted confirm for question "second\?"/,
    )
  })
})
