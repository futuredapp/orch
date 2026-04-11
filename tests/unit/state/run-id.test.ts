import { describe, expect, it } from 'bun:test'
import { FakeClock } from '../../../src/services/index.ts'
import { generateRunId, RUN_ID_PATTERN, type RunId, runId } from '../../../src/state/index.ts'

const rid = (s: string): RunId => s as RunId

describe('generateRunId', () => {
  it('produces r-YYYY-MM-DD-xxxxyy format with a 6-char slug', () => {
    const clock = new FakeClock(1712700000000)

    const id = generateRunId({ clock })

    expect(RUN_ID_PATTERN.test(id)).toBe(true)
  })

  it('uses clock for date portion', () => {
    const epoch = Date.UTC(2026, 3, 10) // 2026-04-10T00:00:00Z
    const clock = new FakeClock(epoch)

    const id = generateRunId({ clock })

    expect(id.startsWith('r-2026-04-10-')).toBe(true)
  })

  it('derives the first four slug chars from the clock time', () => {
    const clock = new FakeClock(0)

    const id = generateRunId({ clock })

    const slug = id.split('-').at(-1) ?? ''
    expect(slug).toHaveLength(6)
    expect(slug.slice(0, 4)).toBe('0000')
  })

  it('includes random entropy so two calls with the same clock produce distinct ids', () => {
    const clock = new FakeClock(1712700000000)

    // 2 base-36 random chars = 1296 slots. With 1000 draws, the birthday-paradox
    // expected unique count is ~623, so the plan's "≥999 unique" target is not
    // attainable with this slug width by design. We still sample 1000 draws and
    // assert the set is far from degenerate: a non-random implementation would
    // yield size === 1.
    const ids = new Set<string>()
    for (let i = 0; i < 1000; i++) {
      ids.add(generateRunId({ clock }))
    }

    expect(ids.size).toBeGreaterThanOrEqual(200)
  })
})

describe('runId', () => {
  it('validates correct format', () => {
    const valid = 'r-2026-04-10-ab3z9k'

    const result = runId(valid)

    expect(result).toBe(rid(valid))
  })

  it('throws on invalid format: missing slug', () => {
    expect(() => runId('r-2026-04-10')).toThrow(/Invalid RunId/)
  })

  it('throws on invalid format: arbitrary string', () => {
    expect(() => runId('bad')).toThrow(/Invalid RunId/)
  })

  it('throws on invalid format: uppercase slug', () => {
    expect(() => runId('r-2026-04-10-ABCDEF')).toThrow(/Invalid RunId/)
  })

  it('accepts the new 6-char slug format and rejects the old 4-char format', () => {
    expect(() => runId('r-2026-04-10-ab3z9k')).not.toThrow()
    expect(() => runId('r-2026-04-10-ab3z')).toThrow(/Invalid RunId/)
  })
})
