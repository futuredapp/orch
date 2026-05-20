/**
 * Pane-content matchers. Each constructor returns a `Matcher` — a pure
 * projector over `LifecycleSnapshot` fields like `leftPaneText` and
 * `leftPaneFocused` (or the right-pane mirrors when passed to
 * `assertRightPane`).
 *
 * U1 declares constructors as stubs. U8 fills in the bodies and binds the
 * pane (`left` vs `right`) at assertion time.
 */

import type { Matcher } from './internal/snapshot.ts'

export type PaneInkState = 'live' | 'viewing' | 'end-of-run' | 'error-banner'

export const containsText = (_needle: string | RegExp): Matcher => {
  throw new Error('containsText not yet implemented — lands in U8')
}

export const doesNotContain = (_needle: string | RegExp): Matcher => {
  throw new Error('doesNotContain not yet implemented — lands in U8')
}

export const isFocused = (): Matcher => {
  throw new Error('isFocused not yet implemented — lands in U8')
}

export const isInState = (_state: PaneInkState): Matcher => {
  throw new Error('isInState not yet implemented — lands in U8')
}

export const hasFooterText = (_text: string | RegExp): Matcher => {
  throw new Error('hasFooterText not yet implemented — lands in U8')
}

export const hasNoLiveOutput = (): Matcher => {
  throw new Error('hasNoLiveOutput not yet implemented — lands in U8')
}

export const isPaneDead = (): Matcher => {
  throw new Error('isPaneDead not yet implemented — lands in U8')
}
