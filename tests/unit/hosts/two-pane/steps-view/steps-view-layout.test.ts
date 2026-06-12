import { describe, expect, it } from 'bun:test'
import type { StepRow } from '../../../../../src/hosts/two-pane/steps-view/step-types.ts'
import {
  followTop,
  offscreenCursorEntry,
  scrollbarTrack,
  visibleWindowRange,
} from '../../../../../src/hosts/two-pane/steps-view/steps-view-layout.ts'

describe('visibleWindowRange', () => {
  it('spans the whole list when every step fits in the viewport', () => {
    expect(visibleWindowRange(5, 0, 10)).toEqual({ start: 1, end: 5 })
  })

  it('names the last window rows when pinned to the live tail', () => {
    expect(visibleWindowRange(40, 0, 8)).toEqual({ start: 33, end: 40 })
  })

  it('shifts the window up by the scroll offset', () => {
    expect(visibleWindowRange(40, 12, 8)).toEqual({ start: 21, end: 28 })
  })

  it('clamps the window start at the first row when fully scrolled', () => {
    expect(visibleWindowRange(40, 32, 8)).toEqual({ start: 1, end: 8 })
  })
})

describe('scrollbarTrack', () => {
  it('renders one char per visible row', () => {
    expect(scrollbarTrack(40, 0, 8)).toHaveLength(8)
  })

  it('puts the thumb at the bottom when pinned to the live tail', () => {
    const track = scrollbarTrack(40, 0, 8)

    expect(track[track.length - 1]).toBe('█')
    expect(track[0]).toBe('░')
  })

  it('puts the thumb at the top when fully scrolled to the oldest step', () => {
    const track = scrollbarTrack(40, 32, 8)

    expect(track[0]).toBe('█')
    expect(track[track.length - 1]).toBe('░')
  })

  it('keeps at least a one-char thumb for very long lists', () => {
    const track = scrollbarTrack(10_000, 0, 8)

    expect(track.filter((c) => c === '█').length).toBeGreaterThanOrEqual(1)
  })

  it('fills the track entirely when every step fits in the viewport', () => {
    expect(scrollbarTrack(5, 0, 10)).toEqual(['█', '█', '█', '█', '█'])
  })
})

describe('followTop', () => {
  it('leaves the window alone while the cursor is inside it', () => {
    expect(followTop(10, 13, 8)).toBe(10)
  })

  it('shifts the window up so a cursor above it lands on the top row', () => {
    expect(followTop(10, 9, 8)).toBe(9)
  })

  it('shifts the window down so a cursor below it lands on the bottom row', () => {
    expect(followTop(10, 18, 8)).toBe(11)
  })

  it('treats the row just past the bottom edge as outside the window', () => {
    expect(followTop(0, 8, 8)).toBe(1)
  })
})

describe('offscreenCursorEntry', () => {
  const steps: readonly StepRow[] = Array.from({ length: 20 }, (_, i) => ({
    kind: 'agent',
    mode: 'autonomous',
    status: i === 19 ? 'running' : 'completed',
    name: `step-${i + 1}`,
    startedAt: i,
  }))

  it('returns undefined while the cursor is inside the rendered window', () => {
    expect(offscreenCursorEntry(steps, 0, 8, 15)).toBeUndefined()
  })

  it('enters at the bottom rendered row when the cursor sits below the window', () => {
    expect(offscreenCursorEntry(steps, 12, 8, 19)).toBe('step-8')
  })

  it('enters at the top rendered row when the cursor sits above the window', () => {
    expect(offscreenCursorEntry(steps, 0, 8, 2)).toBe('step-13')
  })

  it('returns undefined when there is no cursor yet', () => {
    expect(offscreenCursorEntry(steps, 12, 8, -1)).toBeUndefined()
  })
})
