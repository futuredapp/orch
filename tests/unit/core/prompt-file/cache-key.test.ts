// MIGRATED → tests-new/unit/core/prompt-file/cache-key.test.ts (parent U10) — relocated verbatim (import paths only); kept skipped on disk (D2).
import { describe, expect, it } from 'bun:test'
import { canonicalJson, stableHashHex } from '../../../../src/core/prompt-file/cache-key.ts'

describe.skip('stableHashHex', () => {
  it('returns empty string for empty vars (sentinel for no participation in key)', () => {
    expect(stableHashHex({})).toBe('')
  })

  it('returns a stable 16-char hex string for a populated vars object', () => {
    const hash = stableHashHex({ topic: 'A' })

    expect(hash).toHaveLength(16)
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
  })

  it('snapshots the hash for { topic: "A" } so future regressions surface', () => {
    // Snapshot value — if this changes, the canonical-JSON form drifted.
    expect(stableHashHex({ topic: 'A' })).toBe('51d6e5304c16fb08')
  })

  it('produces identical output across two calls with the same vars', () => {
    expect(stableHashHex({ topic: 'A' })).toBe(stableHashHex({ topic: 'A' }))
  })

  it('AE3: produces identical output regardless of key insertion order', () => {
    expect(stableHashHex({ a: 1, b: 2 })).toBe(stableHashHex({ b: 2, a: 1 }))
  })

  it('produces distinct outputs for distinct values', () => {
    expect(stableHashHex({ topic: 'A' })).not.toBe(stableHashHex({ topic: 'B' }))
  })

  it('produces identical outputs for numerically-equal numbers (42 vs 42.0)', () => {
    expect(stableHashHex({ n: 42 })).toBe(stableHashHex({ n: 42.0 }))
  })

  it('distinguishes booleans from string-truthy ("true" vs true)', () => {
    expect(stableHashHex({ flag: true })).not.toBe(stableHashHex({ flag: 'true' }))
  })

  it('correctly escapes embedded quotes in string values (JSON.stringify behavior)', () => {
    // Must not crash; canonical form embeds JSON-escaped quotes.
    const hash = stableHashHex({ x: 'hello "world"' })

    expect(hash).toMatch(/^[0-9a-f]{16}$/)
  })

  it('does not crash on NaN input and produces a stable value', () => {
    const a = stableHashHex({ x: Number.NaN })
    const b = stableHashHex({ x: Number.NaN })

    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
  })

  it('emits only hex characters across a fuzz of inputs (fits STEP_NAME_PATTERN)', () => {
    const hexOnly = /^[0-9a-f]{16}$/
    const samples: Array<Record<string, string | number | boolean>> = [
      { a: 'x' },
      { topic: 'hello', n: 7 },
      { flag: false, label: 'L' },
      { weird: 'value with : colon and - dash' },
      { unicode: 'café' },
      { quote: 'a "b" c' },
      { backslash: 'a\\b' },
      { empty: '' },
      { zero: 0 },
      { negative: -1 },
    ]
    for (const v of samples) {
      expect(stableHashHex(v)).toMatch(hexOnly)
    }
  })
})

describe.skip('canonicalJson', () => {
  it('emits keys in ASCII-sorted order, no whitespace, no surrounding spaces', () => {
    expect(canonicalJson({ b: 'two', a: 'one' })).toBe('{"a":"one","b":"two"}')
  })

  it('stringifies numbers via String() (no quotes)', () => {
    expect(canonicalJson({ n: 42 })).toBe('{"n":42}')
  })

  it('stringifies booleans without quotes', () => {
    expect(canonicalJson({ flag: true })).toBe('{"flag":true}')
  })

  it('escapes embedded quotes via JSON.stringify in string values', () => {
    expect(canonicalJson({ x: 'a"b' })).toBe('{"x":"a\\"b"}')
  })

  it('omits keys whose value is undefined (optional-var omission semantics)', () => {
    const vars = { a: 1, b: undefined as unknown as string }

    expect(canonicalJson(vars)).toBe('{"a":1}')
  })

  it('returns "{}" for an empty object', () => {
    expect(canonicalJson({})).toBe('{}')
  })

  it('treats NaN as the literal "NaN" rather than throwing', () => {
    // NaN canonicalizes to the literal string `NaN`. Workflows passing NaN are
    // buggy, but the hash must not throw.
    expect(canonicalJson({ x: Number.NaN })).toBe('{"x":NaN}')
  })
})
