// MIGRATED → tests-new/unit/services/prompt/readline-prompt-service.test.ts (parent U12) — relocated verbatim (import paths only); kept skipped on disk (D2).
import { describe, expect, it } from 'bun:test'
import { PassThrough } from 'node:stream'
import type { StepName } from '../../../../src/core/types.ts'
import type { Host } from '../../../../src/hosts/index.ts'
import { ReadlinePromptService } from '../../../../src/services/prompt/index.ts'

const SPEC = {
  question: 'continue?',
  fields: [{ name: 'notes' as const, placeholder: 'optional' }],
  buttons: ['continue', 'retry'],
}

interface Harness {
  readonly svc: ReadlinePromptService
  readonly input: PassThrough
  readonly output: PassThrough
  readonly stdoutText: () => string
}

function harness(): Harness {
  const input = new PassThrough()
  const output = new PassThrough()
  const chunks: Buffer[] = []
  output.on('data', (chunk: Buffer) => chunks.push(chunk))
  return {
    svc: new ReadlinePromptService({ input, output }),
    input,
    output,
    stdoutText: () => Buffer.concat(chunks).toString('utf8'),
  }
}

const ctx = { stepName: 'ask:test' as StepName, host: {} as Host }

/**
 * Drives scripted lines into the harness's stdin one at a time, waiting for
 * the prompt service to consume each line before pushing the next. Readline
 * needs to be listening when the line arrives — buffering lines up front
 * causes it to skip them.
 */
function feed(h: Harness, lines: ReadonlyArray<string>): void {
  let i = 0
  const tick = (): void => {
    if (i >= lines.length) return
    h.input.write(`${lines[i]}\n`)
    i += 1
    setTimeout(tick, 5)
  }
  setTimeout(tick, 5)
}

describe.skip('ReadlinePromptService', () => {
  it('reads a field then the chosen button and resolves with the labels', async () => {
    const h = harness()
    feed(h, ['hello', '1'])

    const result = await h.svc.ask(SPEC, ctx)

    expect(result).toEqual({
      cancelled: false,
      button: 'continue',
      fields: { notes: 'hello' },
    })
    expect(h.stdoutText()).toContain('continue?')
    expect(h.stdoutText()).toContain('notes (optional)')
    expect(h.stdoutText()).toContain('(1) continue  (2) retry')
  })

  it('treats empty input on the choice prompt as button[0]', async () => {
    const h = harness()
    feed(h, ['hello', ''])

    const result = await h.svc.ask(SPEC, ctx)

    expect(result).toEqual({
      cancelled: false,
      button: 'continue',
      fields: { notes: 'hello' },
    })
  })

  it('re-prompts on out-of-range button choice with an "invalid choice; pick 1-N" line', async () => {
    const h = harness()
    feed(h, ['hello', '99', '2'])

    const result = await h.svc.ask(SPEC, ctx)

    expect(result).toEqual({
      cancelled: false,
      button: 'retry',
      fields: { notes: 'hello' },
    })
    expect(h.stdoutText()).toContain('invalid choice "99"; pick 1-2')
  })

  it('cancels after MAX_RETRIES (5) consecutive out-of-range choices', async () => {
    const h = harness()
    feed(h, ['hello', '99', '99', '99', '99', '99'])

    const result = await h.svc.ask(SPEC, ctx)

    expect(result.cancelled).toBe(true)
    if (result.cancelled) expect(result.fields).toEqual({ notes: 'hello' })
  })

  it('writes one prompt line per field, in declared order', async () => {
    const spec = {
      question: 'multi',
      fields: [{ name: 'first' as const }, { name: 'second' as const }],
      buttons: ['ok'],
    }
    const h = harness()
    feed(h, ['A', 'B', '1'])

    const result = await h.svc.ask(spec, ctx)

    expect(result).toEqual({
      cancelled: false,
      button: 'ok',
      fields: { first: 'A', second: 'B' },
    })
  })
})
