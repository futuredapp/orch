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
import type { StepRow } from './step-types.ts'

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
  readonly selectedName: string | undefined
  readonly isUserDriven: boolean
  moveUp(): void
  moveDown(): void
  snapToLive(): void
}

export function useStepsSelection(steps: readonly StepRow[]): StepsSelection {
  const [selectedName, setSelectedName] = useState<string | undefined>(undefined)
  const [isUserDriven, setIsUserDriven] = useState(false)

  useEffect(() => {
    if (isUserDriven && selectedName !== undefined) {
      // Selection sticky-on-stepName: if the selected step disappeared, fall
      // back to live.
      const stillThere = steps.some((s) => s.name === selectedName)
      if (!stillThere) {
        setSelectedName(findLive(steps))
        setIsUserDriven(false)
      }
      return
    }
    setSelectedName(findLive(steps) ?? steps[steps.length - 1]?.name)
  }, [steps, isUserDriven, selectedName])

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
    selectedName,
    isUserDriven,
    moveUp: () => move(-1),
    moveDown: () => move(1),
    snapToLive: () => {
      setSelectedName(findLive(steps))
      setIsUserDriven(false)
    },
  }
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
