/**
 * SGR-encoded mouse byte sequence builder for tmux's `send-keys -M`. Plan
 * §6.3 + U5.
 *
 * SGR mouse encoding (xterm spec):
 *   - press:   ESC [ < button ; col ; row M
 *   - release: ESC [ < button ; col ; row m
 *
 * `button` is a small integer (0 = left, 1 = middle, 2 = right). The builder
 * maps the `MouseButton` enum to the corresponding integer.
 */

import type { MouseButton } from './external-tmux-probe.ts'

export interface BuildSgrMouseOptions {
  readonly pressed: boolean
  readonly button: MouseButton
  readonly col: number
  readonly row: number
}

const BUTTON_CODES: Readonly<Record<MouseButton, number>> = {
  left: 0,
  middle: 1,
  right: 2,
}

export const buildSgrMouse = (opts: BuildSgrMouseOptions): string => {
  if (!Number.isInteger(opts.col) || opts.col < 1) {
    throw new Error(`buildSgrMouse: col must be a positive integer (got ${opts.col})`)
  }
  if (!Number.isInteger(opts.row) || opts.row < 1) {
    throw new Error(`buildSgrMouse: row must be a positive integer (got ${opts.row})`)
  }
  const code = BUTTON_CODES[opts.button]
  const terminator = opts.pressed ? 'M' : 'm'
  return `\x1b[<${code};${opts.col};${opts.row}${terminator}`
}
