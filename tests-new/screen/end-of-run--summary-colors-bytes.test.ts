import { scenario } from '../dsl/index.ts'

// Migration (parent U5b / D-P4). The `screen` byte twin of the end-of-run
// summary colours: the green/red status-label SGR survives real tmux. Shares
// `end-of-run-summary-colors`.

scenario(
  {
    name: 'the terminal summary label colour survives real tmux for completed and failed runs',
    feature: 'end-of-run',
    drivers: ['screen'],
    risk: 'summary-colour-bytes',
    overlapGroup: 'end-of-run-summary-colors',
    oldTestRefs: ['tests/unit/hosts/two-pane/steps-view/end-of-run-summary-colors.test.tsx'],
  },
  async (app) => {
    await app.resize(80, 24)
    await app.launch({ steps: ['plan'], stopAt: 'end-of-run' })
    await app.leftPane.assertSummaryColor('completed')

    await app.launch({ steps: ['plan', 'execute'], stopAt: 'end-of-run', outcome: 'failed' })
    await app.leftPane.assertSummaryColor('failed')
  },
)
