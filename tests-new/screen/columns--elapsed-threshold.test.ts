import { scenario } from '../dsl/index.ts'

// Migration (parent U5a / D-P6). The adaptive-column breakpoint is a RENDER risk
// (does the elapsed column survive a narrow pane?), so it is a `screen` byte
// test, not a projection: at width 69 the elapsed value is dropped, at width 80
// it is shown. The pure `pickColumns`/threshold-constant logic is demoted to a
// unit relocation (U10–U13) — it is not a left-pane render scenario. No model
// member, so no overlap group is needed.

scenario(
  {
    name: 'the elapsed column drops below width 70 and reappears at a wide width',
    feature: 'columns',
    drivers: ['screen'],
    risk: 'adaptive-column-bytes',
    oldTestRefs: [
      'tests/unit/hosts/two-pane/steps-view/adaptive-columns.test.ts',
      'tests/unit/hosts/two-pane/steps-view/steps-view.test.tsx',
    ],
  },
  async (app) => {
    // given — a completed step whose elapsed renders as "500ms"
    await app.resize(80, 24)
    await app.launch({ steps: ['plan', 'execute'], stopAt: 'mid-step' })

    // then — at a wide width the elapsed column is present
    await app.leftPane.assertShowsContent('500ms')

    // when — narrowed below the 70-column threshold
    await app.resize(69, 24)

    // then — the elapsed column is dropped (the steps + footer still render)
    await app.leftPane.assertContentAbsent('500ms')
    await app.leftPane.assertShowsContent('plan')
    await app.leftPane.assertQuitHintVisible()
  },
)
