import { describe, expect, it } from 'bun:test'
import {
  type InteractiveResult,
  InteractiveResultSchema,
  type StepMode,
  stepName,
} from '../../../src/core/types.ts'

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

describe('InteractiveResultSchema', () => {
  it('parses a valid InteractiveResult round-trip', () => {
    const input: InteractiveResult = {
      exitCode: 0,
      durationMs: 12345,
      sessionId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    }

    const parsed = InteractiveResultSchema.parse(input)

    expect(parsed).toEqual(input)
  })

  it('rejects non-integer exitCode', () => {
    const result = InteractiveResultSchema.safeParse({
      exitCode: 1.5,
      durationMs: 100,
      sessionId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    })

    expect(result.success).toBe(false)
  })

  it('rejects negative durationMs', () => {
    const result = InteractiveResultSchema.safeParse({
      exitCode: 0,
      durationMs: -1,
      sessionId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    })

    expect(result.success).toBe(false)
  })

  it('rejects non-UUID sessionId', () => {
    const result = InteractiveResultSchema.safeParse({
      exitCode: 0,
      durationMs: 100,
      sessionId: 'not-a-uuid',
    })

    expect(result.success).toBe(false)
  })
})

describe('StepMode compile-time type', () => {
  it('accepts interactive and autonomous as valid StepMode values', () => {
    const interactive: StepMode = 'interactive'
    const autonomous: StepMode = 'autonomous'

    expect(interactive).toBe('interactive')
    expect(autonomous).toBe('autonomous')
  })
})
