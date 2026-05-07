// ---------------------------------------------------------------------------
// adaptive-columns — pure width → ColumnSet picker.
// ---------------------------------------------------------------------------
//
// `<StepsView>` and `<StepRow>` consume a `ColumnSet` and render only the
// fields the layout permits. Today the model exposes only `name`, `glyph`,
// and `elapsed` (cost/tokens are intentionally not threaded through state.json
// in v1) — so the only column that ever drops is `elapsed`, below width 70.
//
// The cost/tokens entries are kept as `false` placeholders rather than
// removed: future phases can flip them on without renaming the type or
// touching any consumer. The 80/95 thresholds documented in the plan are
// preserved here so the next contributor doesn't re-derive them.

export interface ColumnSet {
  readonly name: true
  readonly glyph: true
  readonly elapsed: boolean
  /** Reserved for v2 — `StepEntry` does not carry cost data today. */
  readonly cost: false
  /** Reserved for v2 — `StepEntry` does not carry token data today. */
  readonly tokens: false
}

export const COLUMN_THRESHOLDS = {
  elapsed: 70,
  cost: 80,
  tokens: 95,
} as const

export function pickColumns(width: number): ColumnSet {
  return {
    name: true,
    glyph: true,
    elapsed: width >= COLUMN_THRESHOLDS.elapsed,
    cost: false,
    tokens: false,
  }
}
