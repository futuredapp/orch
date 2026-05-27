// triage: rewrite — banner + view-mode footer now covered at Tier 2 (banner-rendering.test.tsx, view-mode-footer.test.tsx). Rewrite this file to focus on banner↔footer interaction slices the new files do not cover.
// Renderer tests for the U4 banner + view-mode surface on `<StepsView>`.
//
// Covers footer-text-by-view-mode, stepName truncation, banner kind/style,
// Esc precedence (help-close > dismiss-banner > no-op), and auto-dismiss
// timing (info auto-clears, error persists; identical-text emits with bumped
// seq restart the timer).

import { describe, expect, it } from 'bun:test'
import { renderToString } from 'ink'
import { render } from 'ink-testing-library'
import type {
  Banner,
  StepsViewIntent,
  StepsViewState,
  ViewMode,
} from '../../../../../src/hosts/two-pane/steps-view/index.ts'
import { HelpOverlay, StepsView } from '../../../../../src/hosts/two-pane/steps-view/index.ts'
import { stripAnsi } from '../../../../../src/observability/index.ts'
import { waitForIntents } from '../../../../helpers/ink-frame.ts'
import { createManualTimer } from '../../../../helpers/manual-timer.ts'

const NOOP = (): void => {}
const NOW = 5_000

// Let Ink commit the render so the auto-dismiss useEffect has registered its
// timer before the test advances the manual clock.
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function makeLive(overrides?: {
  readonly view?: ViewMode
  readonly banner?: Banner
}): StepsViewState {
  const base: StepsViewState = {
    status: 'live',
    run: { runId: 'r-x', workflowName: 'demo', startedAt: 0 },
    steps: [],
    view: overrides?.view ?? { mode: 'live' },
  }
  if (overrides?.banner !== undefined) {
    return { ...base, banner: overrides.banner }
  }
  return base
}

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('<StepsView> footer derives from view.mode', () => {
  it('renders ▶ live · ⏎ view step · q quit · ? help in live mode (no `f live` token)', () => {
    const frame = stripAnsi(
      renderToString(<StepsView state={makeLive()} onIntent={NOOP} now={() => NOW} />, {
        columns: 110,
      }),
    )

    expect(frame).toContain('▶ live')
    expect(frame).toContain('⏎ view step')
    expect(frame).toContain('q quit')
    expect(frame).toContain('? help')
    // `f live` is hidden in live mode (it's a no-op when already on the
    // most-recent live source).
    expect(frame).not.toContain('f live')
  })

  it('renders ⏸ viewing <stepName> · f live · … in replay mode', () => {
    const state = makeLive({ view: { mode: 'replay', stepName: 'plan' } })

    const frame = stripAnsi(
      renderToString(<StepsView state={state} onIntent={NOOP} now={() => NOW} />, {
        columns: 110,
      }),
    )

    expect(frame).toContain('⏸ viewing plan')
    expect(frame).toContain('f live')
    expect(frame).toContain('⏎ view another')
  })

  it('truncates a long stepName to 30 chars with ellipsis in the footer', () => {
    const long = 'a-very-long-step-name-that-exceeds-thirty-chars'
    const state = makeLive({ view: { mode: 'replay', stepName: long } })

    const frame = stripAnsi(
      renderToString(<StepsView state={state} onIntent={NOOP} now={() => NOW} />, {
        columns: 200,
      }),
    )

    expect(frame).toContain(`${long.slice(0, 29)}…`)
    // The full untruncated stepName must NOT appear in the footer.
    expect(frame).not.toContain(long)
  })
})

describe('<StepsView> banner rendering', () => {
  it('renders an info banner above the steps grid', () => {
    const state = makeLive({
      banner: { kind: 'info', text: 'step plan complete', ttlMs: 4000, seq: 1 },
    })

    const frame = stripAnsi(
      renderToString(<StepsView state={state} onIntent={NOOP} now={() => NOW} />, {
        columns: 110,
      }),
    )

    expect(frame).toContain('step plan complete')
  })

  it('renders an error banner with an Esc-dismiss hint', () => {
    const state = makeLive({
      banner: { kind: 'error', text: 'resume failed', seq: 2 },
    })

    const frame = stripAnsi(
      renderToString(<StepsView state={state} onIntent={NOOP} now={() => NOW} />, {
        columns: 110,
      }),
    )

    expect(frame).toContain('resume failed')
    expect(frame).toContain('Esc dismiss')
  })
})

describe('<StepsView> Esc precedence', () => {
  it('Esc with help open closes help only — does not dispatch dismiss-banner', async () => {
    const intents: StepsViewIntent[] = []
    const state = makeLive({
      banner: { kind: 'error', text: 'oops', seq: 1 },
    })

    const ui = render(<StepsView state={state} onIntent={(i) => intents.push(i)} now={() => NOW} />)
    await tick()
    ui.stdin.write('?') // open help
    await tick()
    ui.stdin.write('') // Esc
    await tick()

    expect(intents.find((i) => i.type === 'dismiss-banner')).toBeUndefined()

    ui.unmount()
  })

  it('Esc with help closed and an error banner dispatches dismiss-banner', async () => {
    const intents: StepsViewIntent[] = []
    const state = makeLive({
      banner: { kind: 'error', text: 'oops', seq: 1 },
    })

    const ui = render(<StepsView state={state} onIntent={(i) => intents.push(i)} now={() => NOW} />)
    await tick()
    ui.stdin.write('') // Esc

    // Poll for the intent — the keypress is processed asynchronously, so a
    // fixed sleep races Ink's input handling.
    await waitForIntents(
      () => intents,
      (seen) => seen.some((i) => i.type === 'dismiss-banner'),
    )

    ui.unmount()
  })

  it('Esc with help closed and no banner is a no-op', async () => {
    const intents: StepsViewIntent[] = []

    const ui = render(
      <StepsView state={makeLive()} onIntent={(i) => intents.push(i)} now={() => NOW} />,
    )
    await tick()
    ui.stdin.write('')
    await tick()

    expect(intents.some((i) => i.type === 'dismiss-banner')).toBe(false)

    ui.unmount()
  })

  it('Esc on an info banner is NOT manually dismissable (auto-clears instead)', async () => {
    const intents: StepsViewIntent[] = []
    const state = makeLive({
      banner: { kind: 'info', text: 'running', ttlMs: 60_000, seq: 1 },
    })

    const ui = render(<StepsView state={state} onIntent={(i) => intents.push(i)} now={() => NOW} />)
    await tick()
    ui.stdin.write('')
    await tick()

    // The Esc keypress itself must not produce a synchronous dismiss-banner.
    // (The async auto-dismiss timer is a separate concern — covered below.)
    const userDispatched = intents.filter((i) => i.type === 'dismiss-banner')
    expect(userDispatched).toHaveLength(0)

    ui.unmount()
  })
})

describe('<StepsView> banner auto-dismiss', () => {
  // These tests drive the auto-dismiss timer through an injected ManualTimer
  // (the `scheduleDismiss` prop) instead of real wall-clock. `advance(ms)` is
  // the only thing that fires the timer, so the assertions are deterministic
  // regardless of React-scheduler latency — the fix for the 2026-05-26 flake.

  it('dispatches dismiss-banner for an info banner after ttlMs elapses', async () => {
    const intents: StepsViewIntent[] = []
    const timer = createManualTimer()
    const state = makeLive({
      banner: { kind: 'info', text: 'running', ttlMs: 80, seq: 1 },
    })

    const ui = render(
      <StepsView
        state={state}
        onIntent={(i) => intents.push(i)}
        now={() => NOW}
        scheduleDismiss={timer.schedule}
      />,
    )
    await flush() // let the effect register the timer

    timer.advance(80) // exactly the ttl

    expect(intents.some((i) => i.type === 'dismiss-banner')).toBe(true)

    ui.unmount()
  })

  it('does NOT auto-dismiss an error banner regardless of ttlMs', async () => {
    const intents: StepsViewIntent[] = []
    const timer = createManualTimer()
    const state = makeLive({
      banner: { kind: 'error', text: 'oops', ttlMs: 50, seq: 1 },
    })

    const ui = render(
      <StepsView
        state={state}
        onIntent={(i) => intents.push(i)}
        now={() => NOW}
        scheduleDismiss={timer.schedule}
      />,
    )
    await flush()

    timer.advance(10_000) // far past the ttl — error banners never schedule

    expect(intents.some((i) => i.type === 'dismiss-banner')).toBe(false)

    ui.unmount()
  })

  it('restarts the auto-dismiss timer when seq bumps even with identical text', async () => {
    const intents: StepsViewIntent[] = []
    const timer = createManualTimer()
    const initial = makeLive({
      banner: { kind: 'info', text: 'running', ttlMs: 150, seq: 1 },
    })
    const bumped = makeLive({
      banner: { kind: 'info', text: 'running', ttlMs: 150, seq: 2 },
    })
    const props = {
      onIntent: (i: StepsViewIntent) => intents.push(i),
      now: () => NOW,
      scheduleDismiss: timer.schedule,
    }

    const ui = render(<StepsView state={initial} {...props} />)
    await flush()

    // Partway through the first banner's ttl, no dismiss yet.
    timer.advance(60)
    expect(intents.some((i) => i.type === 'dismiss-banner')).toBe(false)

    // A bumped emit (same text, seq 2) re-keys the effect: the seq-1 timer is
    // cancelled and a fresh ttl=150 timer is armed at the current time (t=60).
    ui.rerender(<StepsView state={bumped} {...props} />)
    await flush()

    // Without the restart the seq-1 timer would fire at t=150; with it, the
    // seq-2 timer fires at t=60+150=210. At t=209 nothing has fired.
    timer.advance(149)
    expect(intents.some((i) => i.type === 'dismiss-banner')).toBe(false)

    // One more ms crosses the restarted deadline.
    timer.advance(2)
    expect(intents.some((i) => i.type === 'dismiss-banner')).toBe(true)

    ui.unmount()
  })
})

describe('<HelpOverlay> mentions the U4 surface', () => {
  it('lists f, Esc, and the view-mode indicator', () => {
    const frame = stripAnsi(renderToString(<HelpOverlay />, { columns: 110 }))

    expect(frame).toContain('f follow live')
    expect(frame).toContain('Esc')
    expect(frame).toContain('▶ live')
    expect(frame).toContain('⏸ viewing')
    expect(frame).toContain('Banner')
  })
})
