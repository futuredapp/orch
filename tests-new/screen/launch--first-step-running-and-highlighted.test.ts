import { scenario } from '../dsl/index.ts'

// Migration (parent U4.4). The `screen` byte twin of the U4.3 model
// "first step running and highlighted" scenario: the running glyph must render
// as real tmux bytes on the live step. Shares the `launch-first-step` overlap
// group with its model member (parent §5.5).

scenario(
  {
    name: 'the running glyph renders on the first step as real tmux bytes',
    feature: 'launch',
    drivers: ['screen'],
    risk: 'launch-glyph-bytes',
    overlapGroup: 'launch-first-step',
    oldTestRefs: [
      'tests/integration/lifecycle/launch.first-step-is-running-and-highlighted.behavioral.real.test.ts',
    ],
  },
  async (app) => {
    // given — a freshly launched run paused with its first step live
    await app.resize(80, 24)
    await app.launch({ steps: ['plan'], stopAt: 'mid-step' })

    // then — the running glyph survives real tmux on that step
    await app.leftPane.assertGlyph('plan', 'running')
  },
)
