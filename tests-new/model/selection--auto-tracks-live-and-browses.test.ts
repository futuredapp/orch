import { scenario } from '../dsl/index.ts'

// Migration (parent U5a). The `model` half of left-pane SELECTION: at launch the
// committed highlight auto-tracks the live step; arrow-browsing moves the ↑/↓
// preview cursor without disturbing the committed row; `f` snaps back. This is a
// controller DECISION (which row the right pane tracks), so it lives at the
// projection seam — its byte twin (the highlight actually rendering) shares the
// `selection-highlight` overlap group (parent §5.5).

scenario(
  {
    name: 'the committed highlight auto-tracks the live step and browsing leaves it put',
    feature: 'selection',
    drivers: ['model'],
    risk: 'committed-vs-preview',
    overlapGroup: 'selection-highlight',
    oldTestRefs: ['tests/unit/hosts/two-pane/steps-view/selection.test.tsx'],
  },
  async (app) => {
    // given — a run paused with one step done and the next live
    await app.launch({ steps: ['plan', 'execute'], stopAt: 'mid-step' })

    // then — the committed highlight starts on the running (live) step
    await app.leftPane.assertStepSelected('execute')

    // when — the user browses up to a past step
    await app.leftPane.browseTo('plan')

    // then — only the preview cursor moves; the committed row is unchanged
    await app.leftPane.assertPreviewCursorOn('plan')
    await app.leftPane.assertStepSelected('execute')

    // when — follow-live snaps the cursor back to the committed live row
    await app.leftPane.followLive()
    await app.leftPane.assertStepSelected('execute')
  },
)
