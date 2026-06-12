import { scenario } from '../dsl/index.ts'

// Scroll-follow fix (2026-06-11). The `screen` byte twins of the scroll-follow
// model members: off real tmux, the ↑/↓ preview cursor must DRAG the viewport
// with it (the regression was a cursor that walked out of the window and
// "disappeared" while the scrollbar stayed put), `f` must re-pin BOTH the
// selection and the viewport to the live tail, and an arrow pressed while the
// cursor is offscreen must enter the window at its edge instead of yanking the
// viewport back. Geometry: 80×12 → 5 visible step rows over 10 steps (12 rows
// − 2 header − 2 grid borders − 1 footer margin − 1 footer − 1 safety).

const TEN_STEPS = ['a01', 'a02', 'a03', 'a04', 'a05', 'a06', 'a07', 'a08', 'a09', 'a10']

scenario(
  {
    name: 'browsing above the window drags the real-tmux viewport along and f re-pins it to the tail',
    feature: 'scroll-follow',
    drivers: ['screen'],
    risk: 'scroll-follow-bytes',
    overlapGroup: 'scroll-follow',
    oldTestRefs: [],
  },
  async (app) => {
    // given — a short pane whose tail window is a06..a10
    await app.resize(80, 12)
    await app.launch({ steps: TEN_STEPS, stopAt: 'mid-step' })
    await app.leftPane.assertStepOffscreen('a03')

    // when — browsing the preview cursor above the window's top row
    await app.leftPane.browseTo('a03')

    // then — the viewport followed: the cursor is rendered, the footer names
    // the shifted window (a03 is now the top row), nothing "disappeared"
    await app.leftPane.assertPreviewCursorOn('a03')
    await app.leftPane.assertScrolledRange(3, 7, 10)

    // when — f from the scrolled view
    await app.leftPane.followLive()

    // then — selection AND viewport are back at the live tail
    await app.leftPane.assertStepSelected('a10')
    await app.leftPane.assertNotScrolled()
  },
)

scenario(
  {
    name: 'an arrow with the cursor offscreen enters the window edge without yanking the viewport back',
    feature: 'scroll-follow',
    drivers: ['screen'],
    risk: 'scroll-follow-edge-entry-bytes',
    overlapGroup: 'scroll-follow',
    oldTestRefs: [],
  },
  async (app) => {
    // given — scrolled to the oldest steps; the committed cursor (a10, the
    // live tail) is now offscreen below the a01..a05 window
    await app.resize(80, 12)
    await app.launch({ steps: TEN_STEPS, stopAt: 'mid-step' })
    await app.leftPane.scrollToOldest()
    await app.leftPane.assertScrolledRange(1, 5, 10)

    // when — browsing toward a visible row (the first arrow finds the cursor
    // offscreen and must seed it at the window's bottom edge)
    await app.leftPane.browseTo('a05')

    // then — the cursor entered at the edge and the window did not move
    await app.leftPane.assertPreviewCursorOn('a05')
    await app.leftPane.assertScrolledRange(1, 5, 10)
  },
)
