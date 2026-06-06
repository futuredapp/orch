// MIGRATED → tests-new/unit/validators/validation-error.test.ts (parent U12) — relocated verbatim (import paths only); kept skipped on disk (D2).
import { describe, expect, it } from 'bun:test'
import { stepName } from '../../../src/core/types.ts'
import { fail, ok, ValidationError, type ValidationFailure } from '../../../src/validators/index.ts'

describe.skip('ValidationError', () => {
  it('renders every failure in the message with name and reason', () => {
    const failures: ReadonlyArray<ValidationFailure> = [
      { name: 'fileProduced(*.md)', reason: 'no files matched' },
      { name: 'gitDiffCreated', reason: 'no diff since baseline' },
    ]

    const err = new ValidationError(stepName('plan'), failures)

    expect(err.message).toContain('Step "plan" failed validation (2)')
    expect(err.message).toContain('fileProduced(*.md): no files matched')
    expect(err.message).toContain('gitDiffCreated: no diff since baseline')
  })

  it('exposes failures as a readonly array on the instance', () => {
    const failures: ReadonlyArray<ValidationFailure> = [
      { name: 'check@plan#0', reason: 'count was zero', hint: 'did you forget a return?' },
    ]

    const err = new ValidationError(stepName('plan'), failures)

    expect(err.failures).toHaveLength(1)
    expect(err.failures[0]?.name).toBe('check@plan#0')
    expect(err.failures[0]?.reason).toBe('count was zero')
    expect(err.failures[0]?.hint).toBe('did you forget a return?')
  })

  it('is instanceof Error and instanceof ValidationError across the transpile boundary', () => {
    const err = new ValidationError(stepName('plan'), [{ name: 'x', reason: 'y' }])

    expect(err instanceof ValidationError).toBe(true)
    expect(err instanceof Error).toBe(true)
    expect(err.name).toBe('ValidationError')
  })

  it('carries the stepName brand on the instance', () => {
    const err = new ValidationError(stepName('review'), [{ name: 'x', reason: 'y' }])

    expect(err.stepName as string).toBe('review')
  })
})

describe.skip('ok / fail result helpers', () => {
  it('ok() produces a passing ValidatorResult', () => {
    expect(ok()).toEqual({ ok: true })
  })

  it('fail(reason) produces a failing result without a hint', () => {
    expect(fail('something broke')).toEqual({ ok: false, reason: 'something broke' })
  })

  it('fail(reason, hint) attaches the hint', () => {
    expect(fail('count was zero', 'did you forget a return?')).toEqual({
      ok: false,
      reason: 'count was zero',
      hint: 'did you forget a return?',
    })
  })
})
