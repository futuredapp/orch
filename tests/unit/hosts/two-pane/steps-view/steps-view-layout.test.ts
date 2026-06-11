import { describe, expect, it } from 'bun:test'
import {
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
