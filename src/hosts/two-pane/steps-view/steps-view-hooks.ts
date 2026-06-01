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
  snapToLive(): void
}

const LIVE_VIEW: ViewMode = { mode: 'live' }

export function useStepsSelection(
  steps: readonly StepRow[],
  view: ViewMode = LIVE_VIEW,
): StepsSelection {
  // Single source of truth for the highlight: the right pane's `view`. In
  // replay it is the pinned step; in live it is the running step (or the last
  // known step when nothing is live).
  const committedName = committedFromView(steps, view)
  const [selectedName, setSelectedName] = useState<string | undefined>(undefined)
  const [isUserDriven, setIsUserDriven] = useState(false)

  useEffect(() => {
    if (isUserDriven && selectedName !== undefined) {
      // Preview-cursor sticky-on-stepName: if the previewed step disappeared,
      // hand control back to the committed (right-pane) row.
      const stillThere = steps.some((s) => s.name === selectedName)
      if (!stillThere) {
        setSelectedName(committedName)
        setIsUserDriven(false)
      }
      return
    }
    // Not user-driven: the preview cursor tracks the committed row so an idle
    // left pane always points at what the right pane shows — including when the
    // controller auto-advances `view` to the next step without a keypress.
    setSelectedName(committedName)
  }, [steps, isUserDriven, selectedName, committedName])

  const move = (delta: number): void => {
    if (steps.length === 0) return
    const currentIdx =
      selectedName === undefined ? -1 : steps.findIndex((s) => s.name === selectedName)
    // Scan past boundary rows in the requested direction (R24); if no
    // selectable row exists, stay put (no-op delta).
    const nextIdx = nextSelectableIndex(steps, currentIdx, delta)
    if (nextIdx === currentIdx) return
    const target = steps[nextIdx]
    if (target === undefined) return
    setSelectedName(target.name)
    setIsUserDriven(true)
  }

  return {
    committedName,
    selectedName,
    isUserDriven,
    moveUp: () => move(-1),
    moveDown: () => move(1),
    snapToLive: () => {
      setSelectedName(committedName)
      setIsUserDriven(false)
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

  const setTop = (next: number): void => {
    const clamped = clamp(next, 0, maxTop)
    if (clamped >= maxTop) {
      setTopIndex(null)
    } else {
      setTopIndex(clamped)
    }
  }

  return {
    scrollOffset,
    atLiveTail: scrollOffset === 0,
    // Visually, scrollUp moves the window toward step 0 — that's a smaller
    // `topIndex`, which projects to a larger `scrollOffset`.
    scrollUp: () => setTop(effectiveTop - 1),
    scrollDown: () => setTop(effectiveTop + 1),
    pageUp: () => setTop(effectiveTop - page),
    pageDown: () => setTop(effectiveTop + page),
    jumpTop: () => setTop(0),
    jumpBottom: () => {
      setTopIndex(null)
      onFollowLive?.()
    },
  }
}
