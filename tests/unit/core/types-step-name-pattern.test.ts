// U4 — STEP_NAME_PATTERN widening regression. The pattern now permits `>`
// (sub-path separator) and the length bound rose to 512 to accommodate
// realistic depth-8 chains. The legacy alphabet (lowercase, digits, `-`,
// `:`) still validates, and previously-illegal characters (whitespace,
// newlines, uppercase) still throw.

import { describe, expect, it } from 'bun:test'
import { stepName } from '../../../src/core/types.ts'

describe('stepName — widened pattern', () => {
  it('accepts a single `>` mid-string (single-sub cache key)', () => {
    expect(() => stepName('simple-feature>plan')).not.toThrow()
  })

  it('accepts multiple `>` mid-string (nested-sub cache key)', () => {
    expect(() => stepName('outer>inner>plan')).not.toThrow()
  })

  it('accepts the full sub-path + vars-hash shape', () => {
    expect(() => stepName('outer>inner>plan:vars-deadbeefcafe1234')).not.toThrow()
  })

  it('still rejects `>` as the FIRST character', () => {
    expect(() => stepName('>plan')).toThrow(/StepName must match/)
  })

  it('still rejects whitespace', () => {
    expect(() => stepName('foo bar')).toThrow(/StepName must match/)
  })

  it('still rejects newlines', () => {
    expect(() => stepName('foo\nbar')).toThrow(/StepName must match/)
  })

  it('still rejects uppercase characters', () => {
    expect(() => stepName('Foo')).toThrow(/StepName must match/)
  })

  it('still rejects empty', () => {
    expect(() => stepName('')).toThrow(/StepName must not be empty/)
  })
})

describe('stepName — length bound at 512', () => {
  it('accepts a depth-8 chain with 15-char sub names plus a step and vars hash', () => {
    // depth-8 chain: 8 segments of 15 chars + 7 `>` separators = 127 chars
    // + `>` + 10-char step name + `:vars-` + 16-hex = 127 + 1 + 10 + 6 + 16
    // = 160 chars. Well under 512.
    const seg = 'a-very-long-sub' // 15 chars
    const chain = Array.from({ length: 8 }, () => seg).join('>')
    const fullKey = `${chain}>plan-stage:vars-deadbeefcafe1234`
    expect(fullKey.length).toBeLessThan(512)
    expect(() => stepName(fullKey)).not.toThrow()
  })

  it('rejects a name over 512 chars', () => {
    const huge = 'a'.repeat(513)
    expect(() => stepName(huge)).toThrow(/at most 512 characters/)
  })

  it('accepts a name exactly at the 512-char boundary', () => {
    const boundary = 'a'.repeat(512)
    expect(() => stepName(boundary)).not.toThrow()
  })
})
