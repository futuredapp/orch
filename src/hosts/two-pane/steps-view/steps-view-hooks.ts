// ---------------------------------------------------------------------------
// Hooks for `<StepsView>` — adaptive columns + sticky-on-stepName selection.
// ---------------------------------------------------------------------------
//
// Extracted from `steps-view.tsx` so the component file stays under the
// project's 300-line ceiling and so unit tests can exercise the hooks against
// a thin host without mounting the whole `<StepsView>` tree.

import { useStdout } from 'ink'
import { useEffect, useRef, useState } from 'react'
import { type ColumnSet, pickColumns } from './adaptive-columns.ts'
import type { StepRow, ViewMode } from './step-types.ts'
import { followTop } from './steps-view-layout.ts'

const SIGWINCH_DEBOUNCE_MS = 75

export function useAdaptiveColumns(): ColumnSet {
  const { stdout } = useStdout()
  const [columns, setColumns] = useState<ColumnSet>(() => pickColumns(stdout?.columns ?? 80))
  const debounceRef = useRef<NodeJS.Timeout | undefined>(undefined)

  useEffect(() => {
    if (stdout === undefined) return
    const onResize = (): void => {
      if (debounceRef.current !== undefined) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        debounceRef.current = undefined
        setColumns(pickColumns(stdout.columns ?? 80))
      }, SIGWINCH_DEBOUNCE_MS)
      debounceRef.current.unref?.()
    }
    stdout.on('resize', onResize)
    return () => {
      stdout.off('resize', onResize)
      if (debounceRef.current !== undefined) clearTimeout(debounceRef.current)
    }
  }, [stdout])

  return columns
}

export interface StepsSelection {
  /**
   * The step the RIGHT pane is showing, derived from `view`. This is the
   * committed selection: it is rendered as the prominent highlight (cursor +
   * bold + accent) so the left pane always points at what the right pane
   * displays — the HARD invariant from Issue 2. Independent of `↑/↓`.
   */
  readonly committedName: string | undefined
  /**
   * The `↑/↓` preview-cursor position. Equals `committedName` until the user
   * moves it; while moved (`isUserDriven`) it is the candidate the user is
   * browsing and is committed on `Enter`. The right pane does NOT follow it.
   */
  readonly selectedName: string | undefined
  readonly isUserDriven: boolean
  moveUp(): void
  moveDown(): void
  /**
   * Seed the preview cursor directly onto `name` (user-driven). Used when the
   * cursor is outside the scrolled window: the next ↑/↓ enters the window at
   * its edge instead of yanking the viewport back to the offscreen cursor.
   */
  moveInto(name: string): void
  snapToLive(): void
}

const LIVE_VIEW: ViewMode = { mode: 'live' }

// `selectedName` and `isUserDriven` must always change together — updating them
// in two separate `useState` calls lets an intermediate render (selectedName
// changed, isUserDriven still false) trigger the effect's else-branch and reset
// the selection back. A single merged state object makes every move atomic.
interface PreviewCursor {
  readonly selectedName: string | undefined
  readonly isUserDriven: boolean
}

export function useStepsSelection(
  steps: readonly StepRow[],
  view: ViewMode = LIVE_VIEW,
  /**
   * Fired with the cursor's new index after every user-driven move so the
   * caller can keep the scrolled window following the cursor (the reported
   * "↑ walks the indicator out of the viewport" bug).
   */
  onCursorMove?: (index: number) => void,
): StepsSelection {
  // Single source of truth for the highlight: the right pane's `view`. In
  // replay it is the pinned step; in live it is the running step (or the last
  // known step when nothing is live).
  const committedName = committedFromView(steps, view)
  const [cursor, setCursor] = useState<PreviewCursor>({
    selectedName: undefined,
    isUserDriven: false,
  })
  const { selectedName, isUserDriven } = cursor

  // Mirror the latest cursor and steps into refs so `move` always reads current
  // values even when called from a closure captured before the most recent render
  // (e.g. the expose-handle pattern in tests where `handle.selection.moveUp()` is
  // called right after `waitForFrame` sees the new frame but before Ink has flushed
  // the matching expose-effect).
  const cursorRef = useRef(cursor)
  cursorRef.current = cursor
  const stepsRef = useRef(steps)
  stepsRef.current = steps
  const committedRef = useRef(committedName)
  committedRef.current = committedName

  useEffect(() => {
    if (isUserDriven && selectedName !== undefined) {
      // Preview-cursor sticky-on-stepName: if the previewed step disappeared,
      // hand control back to the committed (right-pane) row.
      const stillThere = steps.some((s) => s.name === selectedName)
      if (!stillThere) {
        setCursor({ selectedName: committedName, isUserDriven: false })
      }
      return
    }
    // Not user-driven: track the committed row. Use a functional update so a
    // stale effect scheduled before the user pressed ↑/↓ does not overwrite the
    // cursor: if `prev.isUserDriven` is already true, the user moved between
    // when this effect was scheduled and when it ran — leave the cursor alone.
    setCursor((prev) => {
      if (prev.isUserDriven) return prev
      if (prev.selectedName === committedName) return prev
      return { selectedName: committedName, isUserDriven: false }
    })
  }, [steps, isUserDriven, selectedName, committedName])

  const move = (delta: number): void => {
    const currentSteps = stepsRef.current
    if (currentSteps.length === 0) return
    // Anchor an uninitialised cursor at the COMMITTED row — the value the
    // tracking effect would have set had it flushed before this keystroke.
    // Without this, a press in the pre-effect window fell through to the
    // seed-to-first-row branch, and (with scroll-follow) yanked the viewport
    // to the top of a long list.
    const anchorName = cursorRef.current.selectedName ?? committedRef.current
    const currentIdx =
      anchorName === undefined ? -1 : currentSteps.findIndex((s) => s.name === anchorName)
    // Scan past boundary rows in the requested direction (R24); if no
    // selectable row exists, stay put (no-op delta).
    const nextIdx = nextSelectableIndex(currentSteps, currentIdx, delta)
    if (nextIdx === currentIdx) return
    const target = currentSteps[nextIdx]
    if (target === undefined) return
    const next = { selectedName: target.name, isUserDriven: true }
    // Optimistic ref update: key-repeat can deliver several arrows in ONE
    // tick, before any re-render refreshes `cursorRef` — without this, N
    // same-tick moves all read the same stale cursor and collapse into one.
    cursorRef.current = next
    setCursor(next)
    onCursorMove?.(nextIdx)
  }

  return {
    committedName,
    selectedName,
    isUserDriven,
    moveUp: () => move(-1),
    moveDown: () => move(1),
    moveInto: (name: string) => {
      const idx = stepsRef.current.findIndex((s) => s.name === name)
      if (idx === -1) return
      const next = { selectedName: name, isUserDriven: true }
      cursorRef.current = next
      setCursor(next)
      onCursorMove?.(idx)
    },
    snapToLive: () => {
      setCursor({ selectedName: committedName, isUserDriven: false })
    },
  }
}

function committedFromView(steps: readonly StepRow[], view: ViewMode): string | undefined {
  if (view.mode === 'replay') return view.stepName
  return findLive(steps) ?? lastSelectableName(steps)
}

function findLive(steps: readonly StepRow[]): string | undefined {
  for (const s of steps) {
    if (!isSelectable(s)) continue
    if (s.status === 'running' || s.status === 'interactive') return s.name
  }
  return undefined
}

// R24: the committed cursor must always point at a SELECTABLE row. Without
// this scan, the cursor lands on a `▼`/`✓`/`✗` boundary row whenever the
// projected list ends in one (e.g. a sub fired enter but no child step has
// started yet — `[parent-A, ▼ sub]`), violating the contract that what the
// left pane highlights is what the right pane shows.
function lastSelectableName(steps: readonly StepRow[]): string | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const row = steps[i]
    if (row !== undefined && isSelectable(row)) return row.name
  }
  return undefined
}

type SelectableStepRow = Exclude<StepRow, { kind: 'subworkflow-enter' | 'subworkflow-exit' }>

function isSelectable(row: StepRow): row is SelectableStepRow {
  return row.kind !== 'subworkflow-enter' && row.kind !== 'subworkflow-exit'
}

// Returns the next index in `delta`'s direction whose row is selectable. When
// no selectable row exists in the requested direction, returns `currentIdx`
// (no-op delta — the cursor stays put). When `currentIdx === -1` (no current
// selection — the cursor hasn't been initialised yet), the first ↑ or ↓
// keystroke seeds to the first selectable row in EITHER direction — matching
// the legacy `clamp(-2, 0, max) === 0` behaviour the preview-cursor tests
// expect from a freshly-rendered pane.
function nextSelectableIndex(steps: readonly StepRow[], currentIdx: number, delta: number): number {
  if (delta === 0) return currentIdx
  if (currentIdx === -1) {
    for (let i = 0; i < steps.length; i++) {
      const row = steps[i]
      if (row !== undefined && isSelectable(row)) return i
    }
    return -1
  }
  const step = delta > 0 ? 1 : -1
  let i = currentIdx
  for (;;) {
    i += step
    if (i < 0 || i >= steps.length) return currentIdx
    const row = steps[i]
    if (row !== undefined && isSelectable(row)) return i
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

// ---------------------------------------------------------------------------
// useStepsScroll — keyboard-driven scroll for the steps-view viewport.
// ---------------------------------------------------------------------------
//
// Position is stored as an absolute `topIndex` (or `null` when pinned to the
// live tail) — NOT as offset-from-bottom — so a new step:start event that
// extends the buffer doesn't shift the user's view. The exposed
// `scrollOffset` is derived (rows from the bottom of the buffer) and is what
// the footer renders on. End emits `follow-live` so the right pane re-pins
// to the live source, mirroring the `f`-key precedent.

export interface StepsScroll {
  /** Rows from the bottom of the buffer. 0 ↔ live tail. */
  readonly scrollOffset: number
  readonly atLiveTail: boolean
  scrollUp(): void
  scrollDown(): void
  pageUp(): void
  pageDown(): void
  jumpTop(): void
  jumpBottom(): void
  /** Shift the window the minimum distance so row `index` is rendered. */
  ensureVisible(index: number): void
}

export function useStepsScroll(
  totalSteps: number,
  visibleCount: number,
  onFollowLive?: () => void,
): StepsScroll {
  // `null` means pinned to the live tail; otherwise the value is an absolute
  // top index. Storing the anchor absolutely makes "new step arrives" safe —
  // the top of the window does not move under the user.
  const [topIndex, setTopIndex] = useState<number | null>(null)
  const maxTop = Math.max(0, totalSteps - visibleCount)
  const effectiveTop = topIndex === null ? maxTop : clamp(topIndex, 0, maxTop)
  const scrollOffset = maxTop - effectiveTop
  const page = Math.max(1, visibleCount)

  // Optimistic mirror of `topIndex`: key-repeat delivers several scroll keys
  // in ONE tick, before any re-render refreshes state — reading `effectiveTop`
  // from state would collapse N same-tick moves into one. Refreshed from
  // state on every render, written optimistically on every move.
  const topRef = useRef<number | null>(topIndex)
  topRef.current = topIndex
  const currentTop = (): number =>
    topRef.current === null ? maxTop : clamp(topRef.current, 0, maxTop)

  const setTop = (next: number): void => {
    const clamped = clamp(next, 0, maxTop)
    const value = clamped >= maxTop ? null : clamped
    topRef.current = value
    setTopIndex(value)
  }

  return {
    scrollOffset,
    atLiveTail: scrollOffset === 0,
    // Visually, scrollUp moves the window toward step 0 — that's a smaller
    // `topIndex`, which projects to a larger `scrollOffset`.
    scrollUp: () => setTop(currentTop() - 1),
    scrollDown: () => setTop(currentTop() + 1),
    pageUp: () => setTop(currentTop() - page),
    pageDown: () => setTop(currentTop() + page),
    jumpTop: () => setTop(0),
    jumpBottom: () => {
      topRef.current = null
      setTopIndex(null)
      onFollowLive?.()
    },
    ensureVisible: (index: number) => {
      const top = currentTop()
      const next = followTop(top, index, visibleCount)
      if (next !== top) setTop(next)
    },
  }
}
