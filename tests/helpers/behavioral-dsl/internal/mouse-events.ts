/**
 * SGR-encoded mouse byte sequence builder for tmux's `send-keys -M`. Plan
 * §6.3. Real implementation lands in U5; U1 declares the signature so the
 * probe type can reference it.
 *
 * SGR mouse encoding (xterm spec):
 *   - press:   ESC [ < button ; col ; row M
 *   - release: ESC [ < button ; col ; row m
 *
 * `button` is a small integer (0 = left, 1 = middle, 2 = right, …). The
 * builder below maps the `MouseButton` enum to the corresponding integer.
 */

import type { MouseButton } from './external-tmux-probe.ts'

export interface BuildSgrMouseOptions {
  readonly pressed: boolean
  readonly button: MouseButton
  readonly col: number
  readonly row: number
}

export const buildSgrMouse = (_opts: BuildSgrMouseOptions): string => {
  throw new Error('buildSgrMouse not yet implemented — lands in U5')
}
