import { scenario } from '../dsl/index.ts'

// Migration (parent U4.3). The `model` half of the launch "workflow header and
// step list render" behaviour: every step row is projected and the live-mode
// footer carries the quit hint. The `screen` twin proves these bytes survive
// real tmux; they share the `launch-render` overlap group (parent §5.5).

scenario(
  {
    name: 'launch projects every step row and the live-mode quit hint',
    feature: 'launch',
    drivers: ['model'],
    risk: 'launch-projection',
    overlapGroup: 'launch-render',
    oldTestRefs: [
      'tests/integration/lifecycle/launch.workflow-header-and-step-list-render.behavioral.real.test.ts',
    ],
  },
  async (app) => {
    // given — a multi-step run paused mid-step
    await app.launch({ steps: ['plan', 'execute', 'finalize'], stopAt: 'mid-step' })

    // then — every step row is present (test-authored content via the escape hatch)
    await app.leftPane.assertShowsContent('plan')
    await app.leftPane.assertShowsContent('execute')
    await app.leftPane.assertShowsContent('finalize')

    // and the live-mode footer renders the quit hint exactly once (chrome)
    await app.leftPane.assertQuitHintVisible()
  },
)
