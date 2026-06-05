import { scenario } from '../dsl/index.ts'

// Migration (parent U5a). The `model` half of the PREVIEW CURSOR contract: the
// ↑/↓ cursor is a distinct candidate the user browses; `Enter` commits the
// previewed step (not the committed row); `f` snaps the cursor back to the
// committed row. A controller decision — byte twin shares `preview-cursor`.

scenario(
  {
    name: 'browsing previews a candidate, Enter commits it, f snaps back to committed',
    feature: 'preview-cursor',
    drivers: ['model'],
    risk: 'preview-vs-committed',
    overlapGroup: 'preview-cursor',
    oldTestRefs: ['tests/unit/hosts/two-pane/steps-view/preview-cursor.test.tsx'],
  },
  async (app) => {
    // given — three steps, paused with the last live and committed
    await app.launch({ steps: ['plan', 'execute', 'review'], stopAt: 'mid-step' })
    await app.leftPane.assertStepSelected('review')

    // when — browsing up to a past step previews it without committing
    await app.leftPane.browseTo('plan')
    await app.leftPane.assertPreviewCursorOn('plan')
    await app.leftPane.assertStepSelected('review')

    // when — Enter commits the previewed step (the right pane now tracks it)
    await app.leftPane.selectStep('plan')
    await app.leftPane.assertStepSelected('plan')

    // when — f snaps the committed selection back to the live step
    await app.leftPane.followLive()
    await app.leftPane.assertStepSelected('review')
  },
)
