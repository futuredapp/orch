// Renderer tests for the U4 banner + view-mode surface on `<StepsView>`.
//
// Covers footer-text-by-view-mode, stepName truncation, banner kind/style,
// Esc precedence (help-close > dismiss-banner > no-op), and auto-dismiss
// timing (info auto-clears, error persists; identical-text emits with bumped
// seq restart the timer).

import { describe, expect, it } from 'bun:test'
import { renderToString } from 'ink'
import { render } from 'ink-testing-library'
import React from 'react'
import type {
  Banner,
  StepsViewIntent,
  StepsViewState,
  ViewMode,
} from '../../../../../src/hosts/two-pane/steps-view/index.ts'
import { HelpOverlay, StepsView } from '../../../../../src/hosts/two-pane/steps-view/index.ts'
import { stripAnsi } from '../../../../../src/observability/index.ts'

const NOOP = (): void => {}
const NOW = 5_000

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
    await tick()

    expect(intents.some((i) => i.type === 'dismiss-banner')).toBe(true)

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
  it('dispatches dismiss-banner for an info banner after ttlMs elapses', async () => {
    const intents: StepsViewIntent[] = []
    const state = makeLive({
      banner: { kind: 'info', text: 'running', ttlMs: 80, seq: 1 },
    })

    const ui = render(<StepsView state={state} onIntent={(i) => intents.push(i)} now={() => NOW} />)
    // Wait past the ttl.
    await tick(150)

    expect(intents.some((i) => i.type === 'dismiss-banner')).toBe(true)

    ui.unmount()
  })

  it('does NOT auto-dismiss an error banner regardless of ttlMs', async () => {
    const intents: StepsViewIntent[] = []
    const state = makeLive({
      banner: { kind: 'error', text: 'oops', ttlMs: 50, seq: 1 },
    })

    const ui = render(<StepsView state={state} onIntent={(i) => intents.push(i)} now={() => NOW} />)
    await tick(150)

    expect(intents.some((i) => i.type === 'dismiss-banner')).toBe(false)

    ui.unmount()
  })

  it('restarts the auto-dismiss timer when seq bumps even with identical text', async () => {
    const intents: StepsViewIntent[] = []
    const initial = makeLive({
      banner: { kind: 'info', text: 'running', ttlMs: 80, seq: 1 },
    })
    const bumped = makeLive({
      banner: { kind: 'info', text: 'running', ttlMs: 80, seq: 2 },
    })

    function Harness(): React.ReactElement {
      const [s, setS] = React.useState<StepsViewState>(initial)
      React.useEffect(() => {
        // Halfway through the first banner's ttl, swap to the bumped one.
        const handle = setTimeout(() => setS(bumped), 40)
        return () => clearTimeout(handle)
      }, [])
      return <StepsView state={s} onIntent={(i) => intents.push(i)} now={() => NOW} />
    }

    const ui = render(<Harness />)

    // Wait long enough that, without the seq-keyed restart, the *first*
    // banner's timer would have fired by now (it started at t=0 with ttl=80).
    // The bumped emit at t=40 should reset the timer so dismiss only fires
    // around t = 40 + 80 = 120ms. At t=100ms, no dismiss should have fired.
    await tick(100)

    expect(intents.some((i) => i.type === 'dismiss-banner')).toBe(false)

    // Now wait past the second banner's ttl to confirm the timer is in flight.
    await tick(80)

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
