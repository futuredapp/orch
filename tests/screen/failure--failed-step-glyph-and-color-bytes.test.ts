import { scenario } from '../dsl/index.ts'

// G3 (parent U8 / KD3) — the `screen` byte twin of the failed-step glyph: the
// ✗ glyph and its red SGR survive real tmux. Shares the `failure-glyph` overlap
// group with the `model` half (the blocking overlap report requires both).

scenario(
  {
    name: 'the failed step cross glyph and its red colour survive real tmux',
    feature: 'failure',
    drivers: ['screen'],
    risk: 'failed-glyph-color-bytes',
    overlapGroup: 'failure-glyph',
    oldTestRefs: ['tests/unit/hosts/two-pane/steps-view/steps-view-colors.test.tsx'],
  },
  async (app) => {
    await app.resize(80, 24)
    // given — a run that ended with the last step failed
    await app.launch({ steps: ['plan', 'execute'], stopAt: 'end-of-run', outcome: 'failed' })

    // then — the ✗ glyph renders and its red colour survives the terminal
    await app.leftPane.assertGlyph('execute', 'failed')
    await app.leftPane.assertGlyphColor('execute', 'failed')
  },
)
