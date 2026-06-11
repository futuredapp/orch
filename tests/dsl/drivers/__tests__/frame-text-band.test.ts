// Unit tests for the background-band matcher (full-width selection band,
// 2026-06-11). The fixtures are hand-authored SGR byte strings shaped like
// real `tmux capture-pane -e` output — including tmux's habit of closing a
// run with a full reset (`[0m`) and re-opening the background afterwards.

import { describe, expect, it } from 'bun:test'
import { frameHasFullWidthBand, textPaintedWithBg } from '../frame-text.ts'

const ESC = '\u001B'
const sgr = (params: string): string => `${ESC}[${params}m`

describe('textPaintedWithBg', () => {
  it('returns only the characters painted while the gray background is active', () => {
    const line = `${sgr('100')}▌ step-40${sgr('49')} outside`

    expect(textPaintedWithBg(line, 'gray')).toBe('▌ step-40')
  })

  it('keeps the band open across foreground, bold, and dim changes', () => {
    const line = `${sgr('100')}${sgr('36')}▌${sgr('39')} ${sgr('1')}step-40${sgr('22')}  ${sgr('2')}◐${sgr('22')}   ${sgr('49')}`

    expect(textPaintedWithBg(line, 'gray')).toBe('▌ step-40  ◐   ')
  })

  it('survives a tmux mid-line full reset followed by a background re-open', () => {
    const line = `${sgr('100')}▌ step-40${sgr('0')}${sgr('100')}  ◐    ${sgr('0')}█`

    expect(textPaintedWithBg(line, 'gray')).toBe('▌ step-40  ◐    ')
  })

  it('ends the band at a full reset and at a different background', () => {
    const reset = `${sgr('100')}in${sgr('0')}out`
    const otherBg = `${sgr('100')}in${sgr('44')}out`

    expect(textPaintedWithBg(reset, 'gray')).toBe('in')
    expect(textPaintedWithBg(otherBg, 'gray')).toBe('in')
  })
})

describe('frameHasFullWidthBand', () => {
  it('accepts a row whose band carries the name and a long trailing pad', () => {
    const frame = ['  step-39  ✓', `${sgr('100')}▌ step-40  ◐${' '.repeat(20)}${sgr('49')}█`].join(
      '\n',
    )

    expect(frameHasFullWidthBand(frame, 'step-40', 'gray', 10)).toBe(true)
  })

  it('rejects a band that hugs the text with no trailing pad', () => {
    const frame = `${sgr('100')}▌ step-40  ◐${sgr('49')}${' '.repeat(20)}`

    expect(frameHasFullWidthBand(frame, 'step-40', 'gray', 10)).toBe(false)
  })

  it('rejects a row that names the step with no band at all', () => {
    const frame = `▌ step-40  ◐${' '.repeat(20)}`

    expect(frameHasFullWidthBand(frame, 'step-40', 'gray', 10)).toBe(false)
  })
})
