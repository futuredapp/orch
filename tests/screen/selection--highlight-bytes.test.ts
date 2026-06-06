import { scenario } from '../dsl/index.ts'

// Migration (parent U5a). The `screen` byte twin of the selection model member:
// the committed highlight (`▌` cursor) and the distinct preview cursor (`›`) must
// survive the full Ink→tmux→capture path, not merely be SELECTED by the
// controller. Shares the `selection-highlight` overlap group with §model.

scenario(
  {
    name: 'the committed and preview cursors render as distinct real tmux bytes',
    feature: 'selection',
    drivers: ['screen'],
    risk: 'selection-highlight-bytes',
    overlapGroup: 'selection-highlight',
    oldTestRefs: ['tests/unit/hosts/two-pane/steps-view/selection.test.tsx'],
  },
  async (app) => {
    // given — a paused run at a known width
    await app.resize(80, 24)
    await app.launch({ steps: ['plan', 'execute'], stopAt: 'mid-step' })

    // then — the committed highlight is on the live step (off real bytes)
    await app.leftPane.assertStepSelected('execute')

    // when — browsing to a past step
    await app.leftPane.browseTo('plan')

    // then — the preview cursor sits on it while the committed row holds
    await app.leftPane.assertPreviewCursorOn('plan')
    await app.leftPane.assertStepSelected('execute')
  },
)
