import { scenario } from '../dsl/index.ts'

// Migration (parent U5a / D-P4). The `screen` byte twin of the glyph model
// member: the glyph chars AND their colour SGR survive the real Ink→tmux→capture
// path — a fake tmux cannot prove byte hygiene (R5). Shares `glyph-state-color`.

scenario(
  {
    name: 'step glyphs render with their colours intact off real tmux bytes',
    feature: 'glyph',
    drivers: ['screen'],
    risk: 'glyph-color-bytes',
    overlapGroup: 'glyph-state-color',
    oldTestRefs: ['tests/unit/hosts/two-pane/steps-view/steps-view-colors.test.tsx'],
  },
  async (app) => {
    await app.resize(80, 24)
    await app.launch({ steps: ['plan', 'execute'], stopAt: 'mid-step' })

    await app.leftPane.assertGlyph('execute', 'running')
    await app.leftPane.assertGlyphColor('execute', 'running')
    await app.leftPane.assertGlyph('plan', 'done')
    await app.leftPane.assertGlyphColor('plan', 'done')
  },
)
