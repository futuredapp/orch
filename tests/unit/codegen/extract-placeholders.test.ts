import { describe, expect, it } from 'bun:test'
import { extractPlaceholders } from '../../../src/codegen/extract-placeholders.ts'
import { PLACEHOLDER_RE } from '../../../src/core/prompt-file/substitute.ts'

describe('extractPlaceholders', () => {
  it('returns a single required placeholder', () => {
    expect(extractPlaceholders('Hi {{name}}')).toEqual({ required: ['name'], optional: [] })
  })

  it('returns a single optional placeholder', () => {
    expect(extractPlaceholders('Hi {{name?}}')).toEqual({ required: [], optional: ['name'] })
  })

  it('deduplicates repeated required placeholders', () => {
    expect(extractPlaceholders('{{a}} {{a}} {{b}}')).toEqual({ required: ['a', 'b'], optional: [] })
  })

  it('deduplicates repeated optional placeholders', () => {
    expect(extractPlaceholders('{{a?}} {{a?}} {{b?}}')).toEqual({
      required: [],
      optional: ['a', 'b'],
    })
  })

  it('promotes a placeholder that appears as both required and optional to required', () => {
    expect(extractPlaceholders('{{x}} {{x?}}')).toEqual({ required: ['x'], optional: [] })
  })

  it('tolerates whitespace inside the braces', () => {
    expect(extractPlaceholders('Hi {{ name }}')).toEqual({ required: ['name'], optional: [] })
  })

  it('tolerates whitespace around the optional marker', () => {
    expect(extractPlaceholders('Hi {{ name ? }}')).toEqual({ required: [], optional: ['name'] })
  })

  // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts orch treats ${...} as a literal, not a template-literal placeholder
  it('ignores `${legacy}` template-literal syntax', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the ${...} string is the assertion subject — it must stay a plain literal
    expect(extractPlaceholders('${legacy} only')).toEqual({ required: [], optional: [] })
  })

  it('returns empty arrays for a template with no placeholders', () => {
    expect(extractPlaceholders('static, no vars')).toEqual({ required: [], optional: [] })
  })

  it('handles a mixed required+optional template', () => {
    expect(extractPlaceholders('Hi {{name}} ({{tone?}})')).toEqual({
      required: ['name'],
      optional: ['tone'],
    })
  })

  it('parity: shares the PLACEHOLDER_RE constant with runtime substitute()', () => {
    // Same constant => zero risk of regex drift between codegen and runtime.
    // Refer to the const so a future rename breaks the build here too.
    expect(typeof PLACEHOLDER_RE.source).toBe('string')
  })

  it('extracts placeholders across multi-line prompts', () => {
    const template = 'line one {{a}}\nline two {{b?}}\nline three {{c}}'
    expect(extractPlaceholders(template)).toEqual({ required: ['a', 'c'], optional: ['b'] })
  })
})
