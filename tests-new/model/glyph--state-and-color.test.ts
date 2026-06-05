import { scenario } from '../dsl/index.ts'

// Migration (parent U5a / D-P4). The `model` half of step-row GLYPHS: each
// status renders its glyph char AND its palette colour. On `model` this proves
// the controller SELECTED the colour (asserted over the raw SGR of the rendered
// frame); the byte twin proves those SGR bytes survive real tmux. Shares the
// `glyph-state-color` overlap group. The expected colour is the co-located
// independent spec on the Pane Object, never imported from src/.

scenario(
  {
    name: 'the live and completed step rows render the right glyph in the right colour',
    feature: 'glyph',
    drivers: ['model'],
    risk: 'glyph-color-projection',
    overlapGroup: 'glyph-state-color',
    oldTestRefs: ['tests/unit/hosts/two-pane/steps-view/steps-view-colors.test.tsx'],
  },
  async (app) => {
    // given — one step done, the next live
    await app.launch({ steps: ['plan', 'execute'], stopAt: 'mid-step' })

    // then — running renders ◐ in yellow, completed renders ✓ in green
    await app.leftPane.assertGlyph('execute', 'running')
    await app.leftPane.assertGlyphColor('execute', 'running')
    await app.leftPane.assertGlyph('plan', 'done')
    await app.leftPane.assertGlyphColor('plan', 'done')
  },
)
