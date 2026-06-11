import { describe, expect, it } from 'bun:test'
import { stepFocus } from '../../../src/ui/index.ts'

describe('stepFocus', () => {
  it('moves forward to the next index within range', () => {
    expect(stepFocus(0, 1, 3, true)).toEqual({ type: 'moved', index: 1 })
  })

  it('moves backward to the previous index within range', () => {
    expect(stepFocus(2, -1, 3, true)).toEqual({ type: 'moved', index: 1 })
  })

  it('wraps from the last element to the first when wrap is on', () => {
    expect(stepFocus(2, 1, 3, true)).toEqual({ type: 'moved', index: 0 })
  })

  it('wraps from the first element to the last when wrap is on', () => {
    expect(stepFocus(0, -1, 3, true)).toEqual({ type: 'moved', index: 2 })
  })

  it('reports the after edge instead of wrapping when wrap is off', () => {
    expect(stepFocus(2, 1, 3, false)).toEqual({ type: 'edge', edge: 'after' })
  })

  it('reports the before edge instead of wrapping when wrap is off', () => {
    expect(stepFocus(0, -1, 3, false)).toEqual({ type: 'edge', edge: 'before' })
  })

  it('reports an edge for an empty list', () => {
    expect(stepFocus(0, 1, 0, true)).toEqual({ type: 'edge', edge: 'after' })
    expect(stepFocus(0, -1, 0, true)).toEqual({ type: 'edge', edge: 'before' })
  })
})
