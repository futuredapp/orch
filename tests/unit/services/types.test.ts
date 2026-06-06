// MIGRATED → tests-new/unit/services/types.test.ts (parent U12) — relocated verbatim (import paths only); kept skipped on disk (D2).
import { describe, expect, it } from 'bun:test'
import { path } from '../../../src/services/index.ts'

describe.skip('path() smart constructor', () => {
  it('rejects the empty string as an invalid path', () => {
    expect(() => path('')).toThrow(/empty string/)
  })

  it('rejects paths that contain a ".." traversal segment', () => {
    expect(() => path('../../etc/passwd')).toThrow(/".."/)
    expect(() => path('/var/data/../secret')).toThrow(/".."/)
  })

  it('rejects paths that contain a NUL byte', () => {
    expect(() => path('foo\0bar')).toThrow(/NUL byte/)
  })

  it('accepts a legitimate absolute path and returns it branded', () => {
    const p = path('/tmp/orch/run-1/state.json')

    expect(String(p)).toBe('/tmp/orch/run-1/state.json')
  })
})
