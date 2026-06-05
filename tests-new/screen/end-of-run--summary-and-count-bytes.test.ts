import { scenario } from '../dsl/index.ts'

// Migration (parent U5b). The `screen` byte twin of the end-of-run summary: the
// completion count and the `run completed · …` terminal footer survive real
// tmux. Shares `end-of-run-summary`.

scenario(
  {
    name: 'the end-of-run completion count and terminal footer render as real tmux bytes',
    feature: 'end-of-run',
    drivers: ['screen'],
    risk: 'end-of-run-summary-bytes',
    overlapGroup: 'end-of-run-summary',
    oldTestRefs: [
      'tests/unit/hosts/two-pane/steps-view/end-of-run-summary.test.tsx',
      'tests/unit/hosts/two-pane/steps-view/end-of-run-footer.test.tsx',
      'tests/integration/hosts/two-pane/tier-1/end-of-run-summary-visible.real.integration.test.ts',
    ],
  },
  async (app) => {
    await app.resize(80, 24)
    await app.launch({ steps: ['plan', 'execute', 'review'], stopAt: 'end-of-run' })

    await app.leftPane.assertCompletionCount(3, 3)
    await app.leftPane.assertTerminalFooterVisible('completed')
  },
)
