import { scenario } from '../dsl/index.ts'

// Covers F9 — the model (controller-decision) half of the `follow-live-view-mode`
// overlap group. The `screen` contract twin (footer bytes) lands in parent U2.
//
// This is also the U1 migration tracer in miniature: it proves a new scenario
// runs green against real controller logic. It does NOT skip the old file
// (`tests/integration/hosts/two-pane/tier-1/follow-live-returns-to-running-step.real.integration.test.ts`)
// — that is parent U4.

scenario(
  {
    name: 'pressing follow-live returns the view to the running step',
    feature: 'follow-live',
    drivers: ['model'],
    risk: 'projection-to-screen-binding',
    overlapGroup: 'follow-live-view-mode',
    oldTestRefs: [
      'tests/integration/hosts/two-pane/tier-1/follow-live-returns-to-running-step.real.integration.test.ts',
    ],
  },
  async (app) => {
    // given — a run paused with one step done and the next live
    await app.launch({ steps: ['plan', 'execute'], stopAt: 'mid-step' })

    // when — the user navigated away, then asked to follow the live step
    await app.leftPane.selectStep('plan')
    await app.leftPane.followLive() // ModelApp affordance; records the intent, no tmux

    // then — the controller re-selects the live step (decision, not bytes)
    await app.leftPane.assertStepSelected('execute')
  },
)
