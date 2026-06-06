// MIGRATED → tests-new/unit/core/prompt-file/substitute.test.ts (parent U10) — relocated verbatim (import paths only); kept skipped on disk (D2).
import { describe, expect, it } from 'bun:test'
import { PromptFileError } from '../../../../src/core/prompt-file/errors.ts'
import { assertPromptVars, substitute } from '../../../../src/core/prompt-file/substitute.ts'

describe.skip('substitute', () => {
  it('AE1: substitutes a single named placeholder', () => {
    expect(substitute('Hello {{name}}', { name: 'world' })).toBe('Hello world')
  })

  it('tolerates whitespace inside the braces', () => {
    expect(substitute('{{ name }}', { name: 'x' })).toBe('x')
  })

  it('stringifies a number value via String()', () => {
    expect(substitute('count={{n}}', { n: 42 })).toBe('count=42')
  })

  it('stringifies a boolean value as lowercase', () => {
    expect(substitute('on={{flag}}', { flag: true })).toBe('on=true')
  })

  it('substitutes the same placeholder used multiple times', () => {
    expect(substitute('{{a}} {{a}}', { a: 'x' })).toBe('x x')
  })

  it('substitutes multiple distinct placeholders', () => {
    expect(substitute('{{a}} {{b}}', { a: 'x', b: 'y' })).toBe('x y')
  })

  // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts orch treats ${...} as a literal, not a template-literal placeholder
  it('treats `${var}` as literal — orch does NOT use template-literal syntax', () => {
    // With no vars, $-style "placeholders" are pass-through text. Supplying a
    // `greeting` key would (correctly) trip the extra-key guard, since the
    // template never references {{greeting}}.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the ${...} strings are the assertion subject — they must stay plain literals
    expect(substitute('${greeting}', {})).toBe('${greeting}')
  })

  it('leaves text with spaces between braces unchanged', () => {
    expect(substitute('literal { { not-a-placeholder } }', {})).toBe(
      'literal { { not-a-placeholder } }',
    )
  })

  it('leaves an invalid identifier inside braces unchanged (no dot syntax)', () => {
    expect(substitute('a.b: {{ a.b }}', {})).toBe('a.b: {{ a.b }}')
  })
})

describe.skip('substitute strictness', () => {
  it('AE3: missing-placeholder error names BOTH the placeholder and the supplied key', () => {
    let thrown: unknown
    try {
      substitute('Hello {{userPrompt}}', { user_prompt: 'x' })
    } catch (e) {
      thrown = e
    }

    expect(thrown).toBeInstanceOf(PromptFileError)
    const err = thrown as PromptFileError
    expect(err.cause).toBe('missing-placeholder')
    expect(err.message).toContain('userPrompt')
    expect(err.message).toContain('user_prompt')
  })

  it('throws extra-key when vars supplies an unused key', () => {
    let thrown: unknown
    try {
      substitute('plain text', { extra: 'x' })
    } catch (e) {
      thrown = e
    }

    expect(thrown).toBeInstanceOf(PromptFileError)
    expect((thrown as PromptFileError).cause).toBe('extra-key')
    expect((thrown as PromptFileError).extra).toEqual(['extra'])
  })

  it('throws extra-key when vars supplies a strict superset of placeholders', () => {
    expect(() => substitute('{{a}}', { a: 'x', b: 'y' })).toThrow(PromptFileError)
  })

  it('throws missing-placeholder when the template uses a placeholder with no vars supplied', () => {
    let thrown: unknown
    try {
      substitute('{{name}}', {})
    } catch (e) {
      thrown = e
    }

    expect((thrown as PromptFileError).cause).toBe('missing-placeholder')
    expect((thrown as PromptFileError).missing).toEqual(['name'])
  })
})

describe.skip('assertPromptVars', () => {
  it('AE6: rejects an array value and suggests loadPrompt', () => {
    let thrown: unknown
    try {
      assertPromptVars({ items: ['a', 'b'] })
    } catch (e) {
      thrown = e
    }

    expect(thrown).toBeInstanceOf(PromptFileError)
    const err = thrown as PromptFileError
    expect(err.cause).toBe('unsupported-type')
    expect(err.message).toContain('items')
    expect(err.message).toContain('array')
    expect(err.message).toContain('loadPrompt')
  })

  it('rejects a null value', () => {
    expect(() => assertPromptVars({ x: null })).toThrow(/null/)
  })

  it('rejects an undefined value', () => {
    expect(() => assertPromptVars({ x: undefined })).toThrow(/undefined/)
  })

  it('rejects a nested plain object', () => {
    expect(() => assertPromptVars({ x: { nested: 1 } })).toThrow(PromptFileError)
  })

  it('rejects a top-level array', () => {
    expect(() => assertPromptVars(['a'])).toThrow(/array/)
  })

  it('accepts a mix of strings, numbers, and booleans', () => {
    expect(() => assertPromptVars({ s: 'x', n: 1, b: false })).not.toThrow()
  })
})

describe.skip('substitute optional placeholders ({{x?}})', () => {
  it('substitutes the value when an optional key is supplied', () => {
    expect(substitute('Hi {{name?}}', { name: 'world' })).toBe('Hi world')
  })

  it('substitutes empty string when an optional placeholder has no matching key', () => {
    expect(substitute('Hi {{name?}}', {})).toBe('Hi ')
  })

  it('tolerates whitespace around the optional marker (inside braces)', () => {
    expect(substitute('Hi {{ name? }}', { name: 'x' })).toBe('Hi x')
  })

  it('tolerates whitespace between the identifier and the optional marker', () => {
    expect(substitute('Hi {{ name ? }}', { name: 'x' })).toBe('Hi x')
  })

  it('substitutes a required placeholder alongside an unsupplied optional', () => {
    expect(substitute('Hi {{name}} {{age?}}', { name: 'x' })).toBe('Hi x ')
  })

  it('still throws missing-placeholder for the required key only — optionals never appear', () => {
    let thrown: unknown
    try {
      substitute('Hi {{name}} {{age?}}', {})
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(PromptFileError)
    const err = thrown as PromptFileError
    expect(err.cause).toBe('missing-placeholder')
    expect(err.missing).toEqual(['name'])
  })

  it('throws extra-key when a key is supplied that the template does not reference', () => {
    let thrown: unknown
    try {
      substitute('Hi {{name?}}', { name: 'x', extra: 'y' })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(PromptFileError)
    expect((thrown as PromptFileError).cause).toBe('extra-key')
    expect((thrown as PromptFileError).extra).toEqual(['extra'])
  })
})
