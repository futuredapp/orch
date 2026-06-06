import { scenario } from '../dsl/index.ts'

// Tracer for the `screen` (S2) driver (parent U2, §9.4). The contract twin of
// the U1 `model` tracer (same `overlapGroup`): on `model` the footer assertion
// proves the controller SELECTED the quit hint; here it matches the co-located
// chrome literal against ACTUAL bytes off real tmux, exercising the full
// Ink→tmux→capture path. The `count: 1` guard inside `assertQuitHintVisible`
// catches a double-rendered footer.

scenario(
  {
    name: 'the footer renders the quit hint once at the bottom of the steps pane',
    feature: 'follow-live',
    drivers: ['screen'],
    risk: 'footer-placement',
    overlapGroup: 'follow-live-view-mode',
    oldTestRefs: [
      'tests/integration/hosts/two-pane/tier-1/view-mode-footer-reflects-mode.real.integration.test.ts',
    ],
  },
  async (app) => {
    // given — a run paused mid-step at a known width
    await app.resize(80, 24)
    await app.launch({ steps: ['plan'], stopAt: 'mid-step' })

    // then — actual bytes off real tmux; co-located chrome literal, count guards
    // double-render
    await app.leftPane.assertQuitHintVisible()
  },
)
