import { scenario } from '../dsl/index.ts'

// Migration (parent U4.3). The `model` (controller-decision) half of the launch
// "first step is running and highlighted" behaviour: at launch the live step
// renders the running glyph AND is the committed (highlighted) selection. This
// is a projection-seam decision — no tmux. Its `screen` byte twin (the running
// glyph off real tmux) shares the `launch-first-step` overlap group (parent §5.5).

scenario(
  {
    name: 'at launch the first step is running and is the highlighted selection',
    feature: 'launch',
    drivers: ['model'],
    risk: 'launch-projection',
    overlapGroup: 'launch-first-step',
    oldTestRefs: [
      'tests/integration/lifecycle/launch.first-step-is-running-and-highlighted.behavioral.real.test.ts',
    ],
  },
  async (app) => {
    // given — a freshly launched run paused with its first step live
    await app.launch({ steps: ['plan'], stopAt: 'mid-step' })

    // then — the controller marks that step running and highlights it
    await app.leftPane.assertGlyph('plan', 'running')
    await app.leftPane.assertStepSelected('plan')
  },
)
