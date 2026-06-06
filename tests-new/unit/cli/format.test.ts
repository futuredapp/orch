import { describe, expect, it } from 'bun:test'
import { formatDuration, formatMs, glyphs } from '../../../src/cli/format.ts'
import { makeRunState, makeStepEntry } from '@orch/test/make-step-entry.ts'

describe('glyphs', () => {
  it('returns Unicode glyphs when TTY is true', () => {
    const g = glyphs(true)

    expect(g.completed).toBe('✓')
    expect(g.crashed).toBe('✗')
    expect(g.running).toBe('●')
  })

  it('returns ASCII fallback glyphs when TTY is false', () => {
    const g = glyphs(false)

    expect(g.completed).toBe('+')
    expect(g.crashed).toBe('x')
    expect(g.running).toBe('*')
  })
})

describe('formatMs', () => {
  it('formats sub-second durations as milliseconds', () => {
    expect(formatMs(0)).toBe('0ms')
    expect(formatMs(500)).toBe('500ms')
    expect(formatMs(999)).toBe('999ms')
  })

  it('formats seconds when >= 1000ms and < 60s', () => {
    expect(formatMs(1000)).toBe('1s')
    expect(formatMs(30000)).toBe('30s')
    expect(formatMs(59499)).toBe('59s')
  })

  it('formats minutes and seconds when >= 60s', () => {
    expect(formatMs(60000)).toBe('1m0s')
    expect(formatMs(90000)).toBe('1m30s')
    expect(formatMs(3600000)).toBe('60m0s')
  })
})

describe('formatDuration', () => {
  it('uses endedAt - startedAt when both are present', () => {
    const state = makeRunState({ startedAt: 1000, endedAt: 6000 })

    expect(formatDuration(state)).toBe('5s')
  })

  it('falls back to step timestamps when endedAt is undefined', () => {
    const state = makeRunState({
      endedAt: undefined,
      startedAt: 0,
      steps: {
        a: makeStepEntry({ startedAt: 100, endedAt: 200 }),
        b: makeStepEntry({ startedAt: 300, endedAt: 500 }),
      },
    })

    expect(formatDuration(state)).toBe('400ms')
  })

  it('returns em dash for zero-step runs without endedAt', () => {
    const state = makeRunState({ endedAt: undefined, startedAt: 0, steps: {} })

    expect(formatDuration(state)).toBe('\u2014')
  })
})
