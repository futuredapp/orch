import { describe, expect, it } from 'bun:test'
import { middleEllipsis } from '../../../src/runners/transcript-format-utils.ts'

describe('middleEllipsis', () => {
  it('returns the path unchanged when it already fits within the budget', () => {
    const result = middleEllipsis('src/runners/format-event.ts', 60)

    expect(result).toBe('src/runners/format-event.ts')
  })

  it('keeps the basename and replaces the leading directories with an ellipsis when the path is too long', () => {
    const result = middleEllipsis('/very/long/directory/path/notes.md', 20)

    expect(result).toBe('…/notes.md')
  })

  it('truncates from the end of the basename when the basename alone exceeds the budget', () => {
    const result = middleEllipsis('dir/supercalifragilistic.txt', 12)

    expect(result).toBe('…/listic.txt')
  })
})
