import { describe, expect, it } from 'bun:test'
import { windowId } from '../../../../src/services/tmux/index.ts'

// `WindowId` is the smart constructor for tmux's `@\d+` window ids returned by
// `new-window -P -F '#{window_id}'`. It guards against a `%42` (pane id) or any
// non-digit suffix sneaking through the typed surface — argv built off a bad
// id would target a pane on a select-window call (pane targets fail loudly,
// but pane-target tmux semantics are silently destructive when applied to a
// kill-window).

describe('windowId smart constructor', () => {
  it('accepts well-formed tmux window ids like @0 and @42', () => {
    expect(windowId('@0')).toBe('@0' as ReturnType<typeof windowId>)
    expect(windowId('@42')).toBe('@42' as ReturnType<typeof windowId>)
  })

  it('rejects pane id shapes like %42 (the pane prefix must not pass)', () => {
    expect(() => windowId('%42')).toThrow('invalid window id')
  })

  it('rejects the empty string', () => {
    expect(() => windowId('')).toThrow('invalid window id')
  })

  it('rejects non-digit suffixes like @abc and decimals like @1.2', () => {
    expect(() => windowId('@abc')).toThrow('invalid window id')
    expect(() => windowId('@1.2')).toThrow('invalid window id')
  })
})
