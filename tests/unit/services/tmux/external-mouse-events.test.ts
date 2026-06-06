// MIGRATED → tests-new/tmux-argv/services/tmux/external-mouse-events.test.ts (parent U13) — relocated verbatim (import paths only); kept skipped on disk (D2).
// Unit coverage for `buildSgrMouse`. The builder produces the exact escape
// sequence tmux's `send-keys -M` expects (xterm SGR mouse encoding). The
// probe's end-to-end behavior is exercised in U8's click-to-focus smoke and
// U9's headline cell; here we just pin the byte shape.

import { describe, expect, it } from 'bun:test'
import { buildSgrMouse } from '../../../../tests/helpers/behavioral-dsl/internal/mouse-events.ts'

describe.skip('buildSgrMouse', () => {
  it('encodes a left-button press as ESC[<0;col;rowM', () => {
    expect(buildSgrMouse({ pressed: true, button: 'left', col: 12, row: 5 })).toBe('\x1b[<0;12;5M')
  })

  it('encodes a left-button release as ESC[<0;col;rowm', () => {
    expect(buildSgrMouse({ pressed: false, button: 'left', col: 12, row: 5 })).toBe('\x1b[<0;12;5m')
  })

  it('encodes middle-button events with code 1', () => {
    expect(buildSgrMouse({ pressed: true, button: 'middle', col: 3, row: 4 })).toBe('\x1b[<1;3;4M')
  })

  it('encodes right-button events with code 2', () => {
    expect(buildSgrMouse({ pressed: false, button: 'right', col: 80, row: 24 })).toBe(
      '\x1b[<2;80;24m',
    )
  })

  it('throws when col is non-positive', () => {
    expect(() => buildSgrMouse({ pressed: true, button: 'left', col: 0, row: 1 })).toThrow(
      'col must be a positive integer',
    )
  })

  it('throws when row is non-positive', () => {
    expect(() => buildSgrMouse({ pressed: true, button: 'left', col: 1, row: 0 })).toThrow(
      'row must be a positive integer',
    )
  })

  it('throws when col is non-integer', () => {
    expect(() => buildSgrMouse({ pressed: true, button: 'left', col: 1.5, row: 1 })).toThrow(
      'col must be a positive integer',
    )
  })
})
