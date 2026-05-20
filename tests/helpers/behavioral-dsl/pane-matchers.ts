/**
 * Pane-content matchers. Each constructor returns a `PaneMatcherFactory` —
 * a function that, given the bound pane (`'left'` or `'right'` from the
 * assertion), returns a `Matcher` projecting over the snapshot's pane
 * fields.
 */

import type { LifecycleSnapshot, Matcher, PaneMatcherFactory } from './internal/snapshot.ts'

export type PaneInkState = 'live' | 'viewing' | 'end-of-run' | 'error-banner'

function paneTextOf(snapshot: LifecycleSnapshot, pane: 'left' | 'right'): string {
  return pane === 'left' ? snapshot.leftPaneText : snapshot.rightPaneText
}

function paneFocusedOf(snapshot: LifecycleSnapshot, pane: 'left' | 'right'): boolean {
  return pane === 'left' ? snapshot.leftPaneFocused : snapshot.rightPaneFocused
}

function paneDeadOf(snapshot: LifecycleSnapshot, pane: 'left' | 'right'): boolean | undefined {
  // The snapshot's `panesAlive` is ordered by `tmux list-panes`. We don't
  // know the pane id of "left" / "right" without consulting the probe — the
  // snapshot already pre-resolved leftPaneText / rightPaneText, so we use
  // the panesAlive table positionally as a fallback: index 0 = left, last =
  // right (matches the probe's pane resolution order in
  // `external-tmux-probe.ts`).
  if (snapshot.panesAlive.length === 0) return undefined
  const target = pane === 'left' ? snapshot.panesAlive[0] : snapshot.panesAlive.at(-1)
  return target?.dead
}

const STATE_PATTERNS: Readonly<Record<PaneInkState, RegExp>> = {
  // The Ink steps view renders a live banner using the unicode "▶" + the
  // word "live" (see `src/hosts/two-pane/steps-view/steps-view.tsx`). We
  // tolerate width / coloring variations by matching the icon-and-keyword
  // substring; the strict copy lives in the implementation.
  live: /▶\s*live/i,
  viewing: /viewing/i,
  'end-of-run': /end of run|finished/i,
  'error-banner': /✗|error|failed/i,
}

export const containsText = (needle: string | RegExp): PaneMatcherFactory => {
  return (pane) => (snapshot: LifecycleSnapshot) => {
    const text = paneTextOf(snapshot, pane)
    const ok = typeof needle === 'string' ? text.includes(needle) : needle.test(text)
    if (ok) {
      return {
        matched: true,
        message: `containsText(${formatNeedle(needle)}): matched on ${pane} pane`,
      }
    }
    return {
      matched: false,
      message: `containsText(${formatNeedle(needle)}): not present in ${pane} pane (text=${truncate(text)})`,
    }
  }
}

export const doesNotContain = (needle: string | RegExp): PaneMatcherFactory => {
  return (pane) => (snapshot: LifecycleSnapshot) => {
    const text = paneTextOf(snapshot, pane)
    const present = typeof needle === 'string' ? text.includes(needle) : needle.test(text)
    if (!present) {
      return {
        matched: true,
        message: `doesNotContain(${formatNeedle(needle)}): absent from ${pane} pane`,
      }
    }
    return {
      matched: false,
      message: `doesNotContain(${formatNeedle(needle)}): unexpectedly present in ${pane} pane (text=${truncate(text)})`,
    }
  }
}

export const isFocused = (): PaneMatcherFactory => {
  return (pane) => (snapshot: LifecycleSnapshot) => {
    const focused = paneFocusedOf(snapshot, pane)
    if (focused) {
      return { matched: true, message: `isFocused: ${pane} pane is focused` }
    }
    return {
      matched: false,
      message: `isFocused: ${pane} pane is NOT focused (leftFocused=${snapshot.leftPaneFocused}, rightFocused=${snapshot.rightPaneFocused})`,
    }
  }
}

export const showsInkState = (state: PaneInkState): PaneMatcherFactory => {
  return (pane) => (snapshot: LifecycleSnapshot) => {
    const pattern = STATE_PATTERNS[state]
    const text = paneTextOf(snapshot, pane)
    if (pattern.test(text)) {
      return { matched: true, message: `showsInkState("${state}"): matched on ${pane} pane` }
    }
    return {
      matched: false,
      message: `showsInkState("${state}"): not matched on ${pane} pane (text=${truncate(text)})`,
    }
  }
}

export const hasFooterText = (text: string | RegExp): PaneMatcherFactory => {
  // Footer is the last few lines of the pane text — projector splits and
  // matches against the tail. The exact line count matches what the steps
  // view renders below the live region.
  const FOOTER_LINES = 4
  return (pane) => (snapshot: LifecycleSnapshot) => {
    const body = paneTextOf(snapshot, pane)
    const lines = body.split('\n')
    const footer = lines.slice(-FOOTER_LINES).join('\n')
    const ok = typeof text === 'string' ? footer.includes(text) : text.test(footer)
    if (ok) {
      return {
        matched: true,
        message: `hasFooterText(${formatNeedle(text)}): matched on ${pane} pane footer`,
      }
    }
    return {
      matched: false,
      message: `hasFooterText(${formatNeedle(text)}): not in ${pane} pane footer (footer=${truncate(footer)})`,
    }
  }
}

export const hasNoLiveOutput = (): PaneMatcherFactory => {
  return (pane) => (snapshot: LifecycleSnapshot) => {
    const text = paneTextOf(snapshot, pane).trim()
    if (text.length === 0) {
      return { matched: true, message: `hasNoLiveOutput: ${pane} pane is empty` }
    }
    return {
      matched: false,
      message: `hasNoLiveOutput: ${pane} pane has content (text=${truncate(text)})`,
    }
  }
}

export const isPaneDead = (): PaneMatcherFactory => {
  return (pane) => (snapshot: LifecycleSnapshot) => {
    const dead = paneDeadOf(snapshot, pane)
    if (dead === true) {
      return { matched: true, message: `isPaneDead: ${pane} pane has pane_dead=1` }
    }
    return {
      matched: false,
      message: `isPaneDead: ${pane} pane dead=${dead === undefined ? 'unknown' : 'false'}`,
    }
  }
}

function formatNeedle(n: string | RegExp): string {
  return n instanceof RegExp ? n.toString() : JSON.stringify(n)
}

function truncate(s: string, max = 200): string {
  if (s.length <= max) return JSON.stringify(s)
  return `${JSON.stringify(s.slice(0, max))}… (+${s.length - max} bytes)`
}

// Re-export the Matcher type so consumers of the barrel can import the unified
// type even though pane matchers are PaneMatcherFactory at construction time.
export type { Matcher }
