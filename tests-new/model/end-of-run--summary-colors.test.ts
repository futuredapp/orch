import { scenario } from '../dsl/index.ts'

// Migration (parent U5b / D-P4). The `model` half of END-OF-RUN summary colours:
// the terminal status label renders green when completed, red when failed or
// crashed. The expected colour is the co-located independent spec (D-P4); a
// production palette typo goes red, never laundered. Byte twin shares
// `end-of-run-summary-colors`.

scenario(
  {
    name: 'the terminal summary label is green when completed and red when failed or crashed',
    feature: 'end-of-run',
    drivers: ['model'],
    risk: 'summary-colour-projection',
    overlapGroup: 'end-of-run-summary-colors',
    oldTestRefs: ['tests/unit/hosts/two-pane/steps-view/end-of-run-summary-colors.test.tsx'],
  },
  async (app) => {
    await app.launch({ steps: ['plan'], stopAt: 'end-of-run' })
    await app.leftPane.assertSummaryColor('completed')

    await app.launch({ steps: ['plan', 'execute'], stopAt: 'end-of-run', outcome: 'failed' })
    await app.leftPane.assertSummaryColor('failed')
    await app.leftPane.assertTerminalFooterVisible('failed') // distinct failed footer label

    await app.launch({ steps: ['plan', 'execute'], stopAt: 'end-of-run', outcome: 'crashed' })
    await app.leftPane.assertSummaryColor('crashed')
    await app.leftPane.assertTerminalFooterVisible('crashed') // distinct crashed footer label
  },
)
