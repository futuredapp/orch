import { scenario } from '../dsl/index.ts'

// P3 polish (born-new). The live header carries a status pill and a
// `<done>/<total> steps · <elapsed>` progress line; an overflowing steps grid
// renders a scrollbar; the scrolled footer names the visible window range and
// keeps the `End live` way back. viewportRows pins the window math: 15 rows −
// 7 chrome rows (2 header + 2 grid borders + 1 footer margin + 1 footer +
// 1 safety) = 8 visible step rows.

const FORTY_STEPS = Array.from({ length: 40 }, (_, i) => `step-${String(i + 1).padStart(2, '0')}`)

scenario(
  {
    name: 'the live header shows the status pill and the step progress summary',
    feature: 'polish',
    drivers: ['model'],
    risk: 'header-projection',
    oldTestRefs: [],
  },
  async (app) => {
    // given — a run paused mid-step (3 of 4 steps already completed)
    await app.launch({ steps: ['plan', 'implement', 'review', 'ship'], stopAt: 'mid-step' })

    // then — the pill and the progress line render
    await app.leftPane.assertLivePillVisible()
    await app.leftPane.assertProgressSummary(3, 4)
  },
)

scenario(
  {
    name: 'an overflowing steps grid renders a scrollbar and a short one does not',
    feature: 'polish',
    drivers: ['model'],
    risk: 'scrollbar-projection',
    oldTestRefs: [],
  },
  async (app) => {
    // given — 40 steps in an 8-row window
    await app.launch({ steps: FORTY_STEPS, stopAt: 'mid-step', viewportRows: 15 })

    // then — thumb + track are drawn
    await app.leftPane.assertScrollbarVisible()

    // and given — a run that fits entirely in the viewport
    await app.launch({ steps: ['plan', 'implement'], stopAt: 'mid-step' })

    // then — no track is drawn
    await app.leftPane.assertScrollbarHidden()
  },
)

scenario(
  {
    name: 'the scrolled footer names the visible window range and keeps the End live hint',
    feature: 'polish',
    drivers: ['model'],
    risk: 'scroll-indicator-projection',
    oldTestRefs: [],
  },
  async (app) => {
    // given — 40 steps in an 8-row window, scrolled to the very top
    await app.launch({ steps: FORTY_STEPS, stopAt: 'mid-step', viewportRows: 15 })
    await app.leftPane.scrollToOldest()

    // then — the footer names rows 1–8 of 40 and keeps the way back
    await app.leftPane.assertScrolledRange(1, 8, 40)
    await app.leftPane.assertEndLiveHintVisible()
  },
)
