import { describe, expect, it } from 'bun:test'
import {
  dropLedgeredCases,
  expandBraceTargets,
  isConcretePathTarget,
  isGroupB,
  resolveCases,
  type SkipState,
} from '../reconcile.ts'

// Unit tests for the reconciliation scanner over FIXTURE inputs (not the live
// tree). They prove the load-bearing skip-state AST resolution (#1) — including
// the R13 `skipIf` ≠ `.skip` distinction the parent §7 explicitly demands — plus
// the #3 marker-target path logic, and the import-time-purity property: the
// scanner parses source TEXT and never imports/evaluates a test file, so it
// registers ZERO Bun tests of its own (parent §5.3 / risk P3-B).

function stateOf(source: string, name: string): SkipState | undefined {
  return resolveCases(source, 'fixture.test.ts').find((c) => c.name === name)?.state
}

describe('resolveCases — skip-state AST resolution (#1)', () => {
  it('reports a plain top-level case as live so the scanner flags it unaccounted', () => {
    const source = `
      import { describe, it } from 'bun:test'
      describe('group', () => { it('a live case', () => {}) })
    `

    expect(stateOf(source, 'a live case')).toBe('live')
  })

  it('reports an it.skip case as skipped (migrated)', () => {
    const source = `
      import { describe, it } from 'bun:test'
      describe('group', () => { it.skip('a skipped case', () => {}) })
    `

    expect(stateOf(source, 'a skipped case')).toBe('skipped')
  })

  it('resolves describe.skip ancestry so a wrapped case is seen as skipped', () => {
    const source = `
      import { describe, it } from 'bun:test'
      describe.skip('outer', () => { it('wrapped case', () => {}) })
    `

    expect(stateOf(source, 'wrapped case')).toBe('skipped')
  })

  it('resolves NESTED describe.skip ancestry through an inner describe', () => {
    const source = `
      import { describe, it } from 'bun:test'
      describe.skip('outer', () => {
        describe('inner not itself skipped', () => { it('deep case', () => {}) })
      })
    `

    expect(stateOf(source, 'deep case')).toBe('skipped')
  })

  it('does NOT mistake a skipIf-gated case for a migrated .skip (R13)', () => {
    const source = `
      import { describe, it } from 'bun:test'
      const canRun = () => true
      describe('group', () => { it.skipIf(!canRun())('capability case', () => {}) })
    `

    expect(stateOf(source, 'capability case')).toBe('skipIf')
  })

  it('does NOT treat descendants of a describe.skipIf as migrated', () => {
    const source = `
      import { describe, it } from 'bun:test'
      const canRun = () => true
      describe.skipIf(!canRun())('gated suite', () => { it('gated child', () => {}) })
    `

    expect(stateOf(source, 'gated child')).toBe('live')
  })

  it('treats it.todo as skipped (no runtime assertion)', () => {
    const source = `
      import { describe, it } from 'bun:test'
      describe('group', () => { it.todo('a todo case') })
    `

    expect(stateOf(source, 'a todo case')).toBe('skipped')
  })
})

describe('dropLedgeredCases — drop accounting (#1 fallback)', () => {
  it('collects a case from a ledger row whose disposition cell is exactly drop', () => {
    const ledger = [
      '| Old file | Old case | New scenario (path) | Disposition | Reason |',
      '|---|---|---|---|---|',
      '| old.test.ts | a vacuous assertion | — | drop | tautological |',
    ].join('\n')

    expect(dropLedgeredCases(ledger).has('a vacuous assertion')).toBe(true)
  })

  it('does not collect a case whose disposition is skip-as-covered', () => {
    const ledger = [
      '| old.test.ts | a covered case | tests-new/model/x.test.ts | skip-as-covered | twin |',
    ].join('\n')

    expect(dropLedgeredCases(ledger).has('a covered case')).toBe(false)
  })
})

describe('marker-target path logic (#3)', () => {
  it('accepts a concrete tests-new path target', () => {
    expect(isConcretePathTarget('tests-new/model/x.test.ts')).toBe(true)
  })

  it('rejects prose disposition targets that carry no single file', () => {
    expect(isConcretePathTarget('split')).toBe(false)
    expect(isConcretePathTarget('(dropped)')).toBe(false)
    expect(isConcretePathTarget('never')).toBe(false)
  })

  it('expands a {a,b} brace shorthand into both member paths', () => {
    expect(expandBraceTargets('tests-new/model/x-{a,b}.test.ts')).toEqual([
      'tests-new/model/x-a.test.ts',
      'tests-new/model/x-b.test.ts',
    ])
  })

  it('leaves a plain path untouched when there is no brace', () => {
    expect(expandBraceTargets('tests-new/model/x.test.ts')).toEqual(['tests-new/model/x.test.ts'])
  })
})

describe('group-B surface predicate', () => {
  it('labels a two-pane host path as group-B', () => {
    expect(isGroupB('tests/unit/hosts/two-pane/steps-view/steps-view.test.tsx')).toBe(true)
  })

  it('does not label a core path as group-B', () => {
    expect(isGroupB('tests/unit/core/workflow.test.ts')).toBe(false)
  })
})
