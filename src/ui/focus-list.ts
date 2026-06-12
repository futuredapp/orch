// ---------------------------------------------------------------------------
// focus-list — the shared focus model for orch's Ink form surfaces.
// ---------------------------------------------------------------------------
//
// One ordered list of focusable elements, one focused index, explicit
// stepping with wrap or edge events. Replaces Ink's implicit `useFocus`
// tab-order for the surfaces that need arrow-key navigation (the steps-view
// dialogs, the ask form): with an explicit index the caller can render a
// focus affordance, map ↑/↓/←/→/Tab onto `next`/`prev`, and react when the
// user steps past either end (e.g. hand focus to the other tmux pane).

import { useState } from 'react'

export type FocusStep =
  | { readonly type: 'moved'; readonly index: number }
  | { readonly type: 'edge'; readonly edge: 'before' | 'after' }

/**
 * Pure step: where does focus land when moving `delta` from `index` over
 * `count` elements? With `wrap` the ends connect; without it stepping past
 * an end reports the crossed edge and focus stays put.
 */
export function stepFocus(index: number, delta: 1 | -1, count: number, wrap: boolean): FocusStep {
  if (count <= 0) return { type: 'edge', edge: delta > 0 ? 'after' : 'before' }
  const next = index + delta
  if (next < 0) return wrap ? { type: 'moved', index: count - 1 } : { type: 'edge', edge: 'before' }
  if (next >= count) return wrap ? { type: 'moved', index: 0 } : { type: 'edge', edge: 'after' }
  return { type: 'moved', index: next }
}

export interface UseFocusListOptions {
  readonly count: number
  readonly initialIndex?: number
  /** Connect the ends (default `true`). With `false`, edges fire `onEdge`. */
  readonly wrap?: boolean
  readonly onEdge?: (edge: 'before' | 'after') => void
}

export interface FocusList {
  /** The focused element's index, clamped to the current `count`. */
  readonly index: number
  focus(index: number): void
  next(): void
  prev(): void
}

export function useFocusList(options: UseFocusListOptions): FocusList {
  const { count, initialIndex = 0, wrap = true, onEdge } = options
  const [rawIndex, setRawIndex] = useState(initialIndex)
  // Clamp instead of effect-resetting so a shrinking list never strands the
  // focus out of range mid-render.
  const index = Math.max(0, Math.min(rawIndex, count - 1))

  const move = (delta: 1 | -1): void => {
    const step = stepFocus(index, delta, count, wrap)
    if (step.type === 'moved') setRawIndex(step.index)
    else onEdge?.(step.edge)
  }

  return {
    index,
    focus: (i: number) => setRawIndex(Math.max(0, Math.min(i, count - 1))),
    next: () => move(1),
    prev: () => move(-1),
  }
}
