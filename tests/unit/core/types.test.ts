import { describe, expect, it } from 'bun:test'
import { stepName } from '../../../src/core/types.ts'

describe('stepName', () => {
  it('accepts a colon-separated name like commit:foo', () => {
    const name = stepName('commit:foo')

    expect(name as string).toBe('commit:foo')
  })

  it('accepts a name with multiple colon segments like a:b:c', () => {
    const name = stepName('a:b:c')

    expect(name as string).toBe('a:b:c')
  })

  it('still accepts simple hyphenated names', () => {
    const name = stepName('my-step-1')

    expect(name as string).toBe('my-step-1')
  })

  it('rejects names with uppercase letters', () => {
    expect(() => stepName('Commit:foo')).toThrow('must match')
  })

  it('rejects names starting with a colon', () => {
    expect(() => stepName(':foo')).toThrow('must match')
  })

  it('rejects empty strings', () => {
    expect(() => stepName('')).toThrow('must not be empty')
  })
})
