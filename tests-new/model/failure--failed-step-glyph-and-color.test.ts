import { scenario } from '../dsl/index.ts'

// G3 (parent U8 / KD3) — failure RENDERING. The failed step row renders the ✗
// glyph in red. This closes the U5a-deferred `steps-view-colors` "red-cross"
// case (the U5a ledger assigned the failed-glyph colour to the failure cluster /
// U8). Re-derived through the rendering categories using the existing
// `outcome:'failed'` DSL (NOT lifecycle pane-reads, KD3): the `model` half
// proves the projector SELECTED the failed glyph + colour; the `screen` twin
// (same overlapGroup) proves the bytes survive real tmux.
//
// Note (KD3): the two old `failure.*` "x-glyph-and-error-banner" /
// "right-pane-failure-summary" lifecycle files do NOT assert pane content — they
// assert durable on-disk signals (the pane is torn down sub-100ms at Tier 5), so
// they relocate to `lifecycle/side-effects/` as persistence tests (G4), not here.
// The error-BANNER rendering is already covered by the U5b
// `banner--info-and-error-paint` model/screen twins.

scenario(
  {
    name: 'a failed step row renders the cross glyph in red',
    feature: 'failure',
    drivers: ['model'],
    risk: 'failed-glyph-color-projection',
    overlapGroup: 'failure-glyph',
    oldTestRefs: ['tests/unit/hosts/two-pane/steps-view/steps-view-colors.test.tsx'],
  },
  async (app) => {
    // given — a run that ended with the last step failed
    await app.launch({ steps: ['plan', 'execute'], stopAt: 'end-of-run', outcome: 'failed' })

    // then — the failed step row carries the ✗ glyph in the failed (red) colour
    await app.leftPane.assertGlyph('execute', 'failed')
    await app.leftPane.assertGlyphColor('execute', 'failed')
  },
)
