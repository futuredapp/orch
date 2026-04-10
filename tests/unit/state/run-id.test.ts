import { describe, expect, it } from 'bun:test'
import { generateRunId, RUN_ID_PATTERN, runId, type RunId } from '../../../src/state/index.ts'
import { FakeClock } from '../../../src/services/index.ts'

const rid = (s: string): RunId => s as RunId

describe('generateRunId', () => {
  it('produces r-YYYY-MM-DD-xxxx format', () => {
    const clock = new FakeClock(1712700000000)

    const id = generateRunId({ clock })

    expect(RUN_ID_PATTERN.test(id)).toBe(true)
  })

  it('is stable given a fixed clock', () => {
    const clock = new FakeClock(1712700000000)

    const first = generateRunId({ clock })
    const second = generateRunId({ clock })

    expect(first).toBe(second)
  })

  it('uses clock for date portion', () => {
    const epoch = Date.UTC(2026, 3, 10) // 2026-04-10T00:00:00Z
    const clock = new FakeClock(epoch)

    const id = generateRunId({ clock })

    expect(id.startsWith('r-2026-04-10-')).toBe(true)
  })

  it('pads short slugs to 4 chars', () => {
    const clock = new FakeClock(0)

    const id = generateRunId({ clock })

    const slug = id.split('-').slice(3).join('-')
    expect(slug).toHaveLength(4)
    expect(slug).toBe('0000')
  })
})

describe('runId', () => {
  it('validates correct format', () => {
    const valid = 'r-2026-04-10-ab3z'

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
    expect(() => runId('r-2026-04-10-ABCD')).toThrow(/Invalid RunId/)
  })
})
