import { scenario } from '../dsl/index.ts'

// Migration (parent U5a). The `model` half of left-pane SCROLL: with a bounded
// viewport the live tail shows the newest steps and the oldest is off-window;
// jump-to-top brings it on-screen; jump-to-live returns to the tail. Which rows
// fall inside the window is a projection decision — the byte twin (the window
// actually rendering at a small pane height) shares `scroll-window`.

scenario(
  {
    name: 'a bounded viewport scrolls an off-window step into view and back to the live tail',
    feature: 'scroll',
    drivers: ['model'],
    risk: 'viewport-window',
    overlapGroup: 'scroll-window',
    oldTestRefs: ['tests/unit/hosts/two-pane/steps-view/steps-view-scroll.test.tsx'],
  },
  async (app) => {
    // given — more steps than fit a 10-row viewport
    await app.launch({
      steps: ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'],
      stopAt: 'mid-step',
      viewportRows: 10,
    })

    // then — at the live tail the oldest step is scrolled out
    await app.leftPane.assertStepOffscreen('s1')

    // when — jump to the top
    await app.leftPane.scrollToOldest()
    await app.leftPane.assertStepVisible('s1')

    // when — jump back to the live tail
    await app.leftPane.scrollToLive()
    await app.leftPane.assertStepVisible('s8')
  },
)
