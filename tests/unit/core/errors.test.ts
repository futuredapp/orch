import { describe, expect, it } from 'bun:test'
import type { AskStepConfig } from '../../../src/core/ask.ts'
import { AskNoDefaultError, AskParallelError } from '../../../src/core/errors.ts'
import { stepName } from '../../../src/core/types.ts'

describe('AskParallelError', () => {
  it('carries the step name and a hoist-above-or-fan-in remediation', () => {
    const err = new AskParallelError(stepName('ask:continue'))

    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('AskParallelError')
    expect(err.stepName as string).toBe('ask:continue')
    expect(err.message).toContain('Hoist the ask above')
    expect(err.message).not.toContain('--noninteractive')
  })
})

describe('AskNoDefaultError', () => {
  it('synthesizes the suggested defaultWhenNoninteractive from the actual config', () => {
    const config: AskStepConfig = {
      kind: 'ask',
      question: 'continue?',
      fields: { notes: { placeholder: 'optional' } },
      buttons: ['continue', 'retry'],
    }

    const err = new AskNoDefaultError(stepName('ask:continue'), config)

    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('AskNoDefaultError')
    expect(err.message).toContain('ask:continue')
    expect(err.message).toContain("'continue'")
    expect(err.message).toContain("'retry'")
    expect(err.message).toContain("notes: ''")
    expect(err.message).toContain("'notes'")
  })

  it('omits the field hint when there are no fields', () => {
    const config: AskStepConfig = {
      kind: 'ask',
      question: 'q?',
      fields: {},
      buttons: ['ok'],
    }

    const err = new AskNoDefaultError(stepName('ask:q'), config)

    expect(err.message).toContain("'ok'")
    expect(err.message).not.toContain('field keys')
  })
})
