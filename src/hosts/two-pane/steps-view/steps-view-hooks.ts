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
    const nextIdx = clamp(currentIdx + delta, 0, steps.length - 1)
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
  return findLive(steps) ?? steps[steps.length - 1]?.name
}

function findLive(steps: readonly StepRow[]): string | undefined {
  for (const s of steps) {
    if (s.status === 'running' || s.status === 'interactive') return s.name
  }
  return undefined
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
