// Category-A demote (parent U13, PD5) — extracted verbatim from the MIXED file
// tests/unit/hosts/two-pane/steps-view/adaptive-columns.test.ts. Only the pure
// `COLUMN_THRESHOLDS` policy case demotes to a plain `unit` test here; the
// adaptive-column RENDER case (`pickColumns` breakpoints) is group-B render and
// stays LIVE in the old file (D15 — no premature full skip). See ledger.

import { describe, expect, it } from 'bun:test'
import { COLUMN_THRESHOLDS } from '../../../../src/hosts/two-pane/steps-view/index.ts'

describe('pickColumns', () => {
  it('exposes the documented threshold constants so future phases can flip cost/tokens on without forking the policy', () => {
    expect(COLUMN_THRESHOLDS.elapsed).toBe(70)
    expect(COLUMN_THRESHOLDS.cost).toBe(80)
    expect(COLUMN_THRESHOLDS.tokens).toBe(95)
  })
})
