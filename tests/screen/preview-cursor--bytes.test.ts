import { scenario } from '../dsl/index.ts'

// Migration (parent U5a). The `screen` byte twin of the preview-cursor model
// member: the `›` preview cursor and the committed `▌` never coincide on real
// tmux, and a committed Enter moves the highlight. Shares `preview-cursor`.

scenario(
  {
    name: 'the preview cursor and committed highlight render as distinct tmux bytes through a commit',
    feature: 'preview-cursor',
    drivers: ['screen'],
    risk: 'preview-cursor-bytes',
    overlapGroup: 'preview-cursor',
    oldTestRefs: ['tests/unit/hosts/two-pane/steps-view/preview-cursor.test.tsx'],
  },
  async (app) => {
    await app.resize(80, 24)
    await app.launch({ steps: ['plan', 'execute', 'review'], stopAt: 'mid-step' })

    await app.leftPane.browseTo('plan')
    await app.leftPane.assertPreviewCursorOn('plan')
    await app.leftPane.assertStepSelected('review')

    await app.leftPane.selectStep('plan')
    await app.leftPane.assertStepSelected('plan')
  },
)
