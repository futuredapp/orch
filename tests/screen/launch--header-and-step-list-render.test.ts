import { scenario } from '../dsl/index.ts'

// Migration (parent U4.4). The `screen` byte twin of the U4.3 model launch-render
// scenario: every step row and the live-mode quit hint must survive the full
// Ink→tmux→capture path, not just be SELECTED by the controller. Shares the
// `launch-render` overlap group with its model member (parent §5.5).

scenario(
  {
    name: 'launch renders every step row and the quit hint as real tmux bytes',
    feature: 'launch',
    drivers: ['screen'],
    risk: 'launch-rendering-bytes',
    overlapGroup: 'launch-render',
    oldTestRefs: [
      'tests/integration/lifecycle/launch.workflow-header-and-step-list-render.behavioral.real.test.ts',
    ],
  },
  async (app) => {
    // given — a multi-step run at a known width
    await app.resize(80, 24)
    await app.launch({ steps: ['plan', 'execute', 'finalize'], stopAt: 'mid-step' })

    // then — actual bytes off real tmux: every step row and the footer chrome
    await app.leftPane.assertShowsContent('plan')
    await app.leftPane.assertShowsContent('execute')
    await app.leftPane.assertShowsContent('finalize')
    await app.leftPane.assertQuitHintVisible()
  },
)
