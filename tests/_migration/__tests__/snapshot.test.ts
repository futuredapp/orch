import { describe, expect, it } from 'bun:test'
import { extractCases, generateBaseline, renderJson } from '../snapshot.ts'

// The baseline is the frozen source of truth for migration completeness (D12),
// so its generator must be deterministic and classify correctly. It parses
// source via the TS AST and never imports a test file, so generating it
// registers zero Bun tests (proven by construction — no import path exists).

describe('generateBaseline is deterministic', () => {
  it('produces byte-identical JSON on two runs over the same tree', () => {
    const first = renderJson(generateBaseline())
    const second = renderJson(generateBaseline())

    expect(second).toBe(first)
  })
})

describe('generateBaseline classifies every path by an auditable rule', () => {
  const baseline = generateBaseline()

  it('classifies every .test-d.ts as a type-test and every .test.ts(x) as a test', () => {
    for (const entry of baseline.files) {
      if (entry.path.endsWith('.test-d.ts')) {
        expect(entry.classification).toBe('type-test')
      } else if (entry.path.endsWith('.test.ts') || entry.path.endsWith('.test.tsx')) {
        expect(entry.classification).toBe('test')
      }
    }
  })

  it('classifies a tests/_support file as a helper', () => {
    const helper = baseline.files.find((f) => f.path === 'tests/_support/make-step-entry.ts')

    expect(helper?.classification).toBe('helper')
  })

  it('records cases only on test files and counts them', () => {
    const withCases = baseline.files.filter((f) => (f.cases?.length ?? 0) > 0)
    const nonTestWithCases = baseline.files.filter(
      (f) => f.classification !== 'test' && f.cases !== undefined,
    )

    expect(withCases.length).toBeGreaterThan(0)
    expect(nonTestWithCases).toEqual([])
    expect(baseline.caseCount).toBe(
      baseline.files.reduce((sum, f) => sum + (f.cases?.length ?? 0), 0),
    )
  })
})

describe('extractCases parses it/test/it.each but not describe', () => {
  it('captures plain it(), test(), it.skip(), and it.each() cases by name', () => {
    const source = `
      import { describe, it, test } from 'bun:test'
      describe('a group', () => {
        it('does a thing', () => {})
        test('also a thing', () => {})
        it.skip('a skipped thing', () => {})
        it.each([1, 2])('handles %s', () => {})
      })
    `

    const cases = extractCases(source, 'synthetic.test.ts')
    const names = cases.map((c) => c.name)

    expect(names).toEqual(['does a thing', 'also a thing', 'a skipped thing', 'handles %s'])
    expect(cases.every((c) => c.line > 0 && c.hash.length === 8)).toBe(true)
  })

  it('does not capture the describe() group name as a case', () => {
    const source = `describe('not a case', () => { it('is a case', () => {}) })`

    const cases = extractCases(source, 'synthetic.test.ts')

    expect(cases.map((c) => c.name)).toEqual(['is a case'])
  })
})
