// COVERED BY → tests-new/screen/columns--elapsed-threshold.test.ts + tests-new/unit/hosts/two-pane/adaptive-columns-thresholds.test.ts (parent U14 group-B closeout) — see ledger. Kept skipped on disk (D2). (mixed — see ledger)
// Pure-function table tests for the adaptive-columns picker.
//
// Phase 1 only ever drops the `elapsed` column (cost/tokens are reserved
// for v2 — they stay `false` regardless of width). The 70/80/95 thresholds
// are documented in `COLUMN_THRESHOLDS`; the table here pins the picker's
// behavior at + and - around each one.

import { describe, expect, it } from 'bun:test'
import {
  COLUMN_THRESHOLDS,
  pickColumns,
} from '../../../../../src/hosts/two-pane/steps-view/index.ts'

describe.skip('pickColumns', () => {
  it('hides elapsed below width 70 and exposes it from 70 upward across the canonical breakpoints', () => {
    const cases: ReadonlyArray<{ readonly width: number; readonly elapsed: boolean }> = [
      { width: 60, elapsed: false },
      { width: 69, elapsed: false },
      { width: 70, elapsed: true },
      { width: 80, elapsed: true },
      { width: 95, elapsed: true },
      { width: 110, elapsed: true },
    ]

    for (const c of cases) {
      const cols = pickColumns(c.width)

      expect(cols.elapsed).toBe(c.elapsed)
      expect(cols.cost).toBe(false)
      expect(cols.tokens).toBe(false)
      expect(cols.name).toBe(true)
      expect(cols.glyph).toBe(true)
    }
  })

  it('exposes the documented threshold constants so future phases can flip cost/tokens on without forking the policy', () => {
    expect(COLUMN_THRESHOLDS.elapsed).toBe(70)
    expect(COLUMN_THRESHOLDS.cost).toBe(80)
    expect(COLUMN_THRESHOLDS.tokens).toBe(95)
  })
})
