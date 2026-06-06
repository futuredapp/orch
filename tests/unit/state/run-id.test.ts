// MIGRATED → tests-new/unit/state/run-id.test.ts (parent U12) — relocated verbatim (import paths only); kept skipped on disk (D2).
import { describe, expect, it } from 'bun:test'
import { FakeClock } from '../../../src/services/index.ts'
import { generateRunId, RUN_ID_PATTERN, type RunId, runId } from '../../../src/state/index.ts'

const rid = (s: string): RunId => s as RunId

describe.skip('generateRunId', () => {
  it('produces r-YYYY-MM-DD-HHMMSS-xx format', () => {
    const clock = new FakeClock(1712700000000)

    const id = generateRunId({ clock })

    expect(RUN_ID_PATTERN.test(id)).toBe(true)
  })

  it('uses clock for date and time portions in local time', () => {
    // 2026-04-10T00:00:00 local — assert via regex shape, not a fixed
    // HHMMSS, so the test stays timezone-agnostic on CI.
    const d = new Date(2026, 3, 10, 0, 0, 0, 0)
    const clock = new FakeClock(d.getTime())

    const id = generateRunId({ clock })

    expect(id.startsWith('r-2026-04-10-')).toBe(true)
    expect(id).toMatch(/^r-\d{4}-\d{2}-\d{2}-\d{6}-[a-z0-9]{2}$/)
  })

  it('derives the time slug from clock.getHours/getMinutes/getSeconds', () => {
    const t1 = new Date(2026, 3, 10, 12, 30, 15, 0).getTime()
    const t2 = new Date(2026, 3, 10, 12, 30, 16, 0).getTime()

    const id1 = generateRunId({ clock: new FakeClock(t1) })
    const id2 = generateRunId({ clock: new FakeClock(t2) })

    const slug1 = id1.split('-').slice(-2, -1)[0] ?? ''
    const slug2 = id2.split('-').slice(-2, -1)[0] ?? ''
    expect(slug1).toHaveLength(6)
    expect(slug2).toHaveLength(6)
    // The two epochs are exactly one second apart; the time segment must
    // differ by 1 (interpreted as a 6-digit number).
    expect(parseInt(slug2, 10) - parseInt(slug1, 10)).toBe(1)
  })

  it('two calls within the same second produce distinct IDs', () => {
    const clock = new FakeClock(1712700000000)

    // 2 base-36 random chars = 1296 slots. With 1000 draws, the birthday-paradox
    // expected unique count is ~623; we assert the set is far from degenerate.
    const ids = new Set<string>()
    for (let i = 0; i < 1000; i++) {
      ids.add(generateRunId({ clock }))
    }

    expect(ids.size).toBeGreaterThanOrEqual(200)
  })
})

describe.skip('runId', () => {
  it('validates correct format', () => {
    const valid = 'r-2026-04-10-143052-7k'

    const result = runId(valid)

    expect(result).toBe(rid(valid))
  })

  it('throws on invalid format: missing time/suffix segments', () => {
    expect(() => runId('r-2026-04-10')).toThrow(/Invalid RunId/)
  })

  it('throws on invalid format: arbitrary string', () => {
    expect(() => runId('bad')).toThrow(/Invalid RunId/)
  })

  it('throws on invalid format: uppercase suffix', () => {
    expect(() => runId('r-2026-04-10-143052-AA')).toThrow(/Invalid RunId/)
  })

  it('rejects the old 6-char-slug format and accepts the new format', () => {
    expect(() => runId('r-2026-04-10-ab3z9k')).toThrow(/Invalid RunId/)
    expect(() => runId('r-2026-04-10-143052-7k')).not.toThrow()
  })
})
