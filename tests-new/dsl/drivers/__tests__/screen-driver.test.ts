import { existsSync, readdirSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'bun:test'
import { canRunRealTmux, REAL_TMUX_TEST_TIMEOUT_MS } from '@orch/test/real-tmux/index.ts'
import type { DriverName, ScreenApp } from '../../app-surfaces.ts'
import type { ScenarioMeta } from '../../scenario.ts'
import { screenDriver } from '../screen-driver.ts'

// Driver-level regression tests for the net-new `screen` (S2) single-pane
// driver. They characterize the real-tmux lifecycle (unique socket, teardown
// reaps), the resize/re-render risk class, and — crucially — the adversarial
// byte catalogue (parent §5.7): byte hygiene can ONLY be proven on real tmux
// (parent §5.1, R5), never against a fake.

const tmuxAvailable = canRunRealTmux()

const META: ScenarioMeta<readonly DriverName[]> = {
  name: 'driver-test',
  drivers: ['screen'],
  feature: 'driver',
  oldTestRefs: [],
}

let apps: ScreenApp[] = []

afterEach(async () => {
  for (const app of apps) await app.teardown().catch(() => {})
  apps = []
})

async function buildApp(): Promise<ScreenApp> {
  const app = await screenDriver.build(META)
  apps.push(app)
  return app
}

describe('screen driver — real-tmux single-pane lifecycle', () => {
  it.skipIf(!tmuxAvailable)(
    'allocates a unique socket on launch and removes it on teardown',
    async () => {
      const socketsBefore = listOrchSockets()

      const app = await buildApp()
      await app.launch({ steps: ['plan', 'execute'], stopAt: 'mid-step' })
      await app.leftPane.assertQuitHintVisible()

      expect(listOrchSockets().length).toBeGreaterThan(socketsBefore.length)

      await app.teardown()
      expect(listOrchSockets()).toEqual(socketsBefore)
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )

  it('budgets the test with REAL_TMUX_TEST_TIMEOUT_MS, not Bun’s 5s default', () => {
    expect(screenDriver.timeout).toBe(REAL_TMUX_TEST_TIMEOUT_MS)
  })

  it('skips itself on a box without real tmux (predicate prevents false failure)', () => {
    expect(screenDriver.skip()).toBe(!canRunRealTmux())
  })

  it.skipIf(!tmuxAvailable)('has no rightPane — a screen test exercises only the left pane', async () => {
    const app = await buildApp()
    await app.launch({ steps: ['plan'], stopAt: 'mid-step' })

    // Type rejects `app.rightPane`; the property is also structurally absent.
    expect('rightPane' in app).toBe(false)
  })
})

describe('screen driver — rendering off real tmux bytes', () => {
  it.skipIf(!tmuxAvailable)(
    'renders the running glyph on the live step (real bytes, not a projection)',
    async () => {
      const app = await buildApp()
      await app.resize(80, 24)
      await app.launch({ steps: ['plan', 'execute'], stopAt: 'mid-step' })

      await app.leftPane.assertGlyph('execute', 'running')
      await app.leftPane.assertGlyph('plan', 'done')
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )
})

describe('screen driver — resize re-renders the steps pane', () => {
  it.skipIf(!tmuxAvailable)(
    'a narrow width renders the footer exactly once (no duplicate render) and a wide width lays out cleanly',
    async () => {
      const app = await buildApp()
      await app.resize(80, 24)
      await app.launch({ steps: ['plan', 'execute'], stopAt: 'mid-step' })
      await app.leftPane.assertQuitHintVisible()

      // Narrow: footer still renders exactly once (count guard catches a
      // double-rendered footer/header — the SIGWINCH duplication risk class).
      await app.resize(48, 24)
      await app.leftPane.assertQuitHintVisible()

      // Wide: lays out without losing the footer or the steps.
      await app.resize(160, 40)
      await app.leftPane.assertQuitHintVisible()
      await app.leftPane.assertShowsContent('plan')
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )
})

// Adversarial byte catalogue (parent §5.7), table-driven. Each payload is fed as
// subprocess-controlled content (a step name) through the real Ink→tmux→capture
// path; the pane must survive without corrupting — the footer chrome still
// renders, the sibling safe step is still visible, and no caret-notation echo
// leaks. A fake tmux could not prove any of this.
const ADVERSARIAL: Readonly<Record<string, string>> = {
  'ansi sequences': '\x1b[31mRED\x1b[0m',
  'carriage returns': 'before\rafter',
  'NUL byte': 'left\x00right',
  'wide glyphs': 'cjk-日本語-字',
  'a very long line': `L${'o'.repeat(400)}ng`,
  'chunk-boundary fragments': `frag-\x1b[1m-${'x'.repeat(120)}-\r-end`,
}

describe('screen driver — adversarial byte catalogue survives real tmux', () => {
  for (const [label, payload] of Object.entries(ADVERSARIAL)) {
    it.skipIf(!tmuxAvailable)(
      `keeps the pane intact when a step name contains ${label}`,
      async () => {
        const app = await buildApp()
        await app.resize(80, 24)
        await app.launch({ steps: ['safe-step', payload], stopAt: 'mid-step' })

        // Pane survived: chrome + the sibling safe step still render, and no
        // caret-notation echo leaked into the captured bytes.
        await app.leftPane.assertQuitHintVisible()
        await app.leftPane.assertShowsContent('safe-step')
        await app.leftPane.assertNoCaretEcho()
      },
      REAL_TMUX_TEST_TIMEOUT_MS,
    )
  }
})

// Navigation protocol over real tmux (parent U4.2, K3). These are the
// highest-risk affordances — a keystroke race over real tmux is where every
// historical flake lived (REGRESSION 2026-05-29 nav.f-snaps) — so they are
// characterized at the driver level before any behaviour scenario leans on them.
describe('screen driver — keystroke navigation over real tmux', () => {
  it.skipIf(!tmuxAvailable)(
    'selectStep commits the highlight to the chosen step via arrow keys + Enter',
    async () => {
      const app = await buildApp()
      await app.resize(80, 24)
      await app.launch({ steps: ['plan', 'execute'], stopAt: 'mid-step' })

      // Live mode starts committed to the running step (the last one).
      await app.leftPane.assertStepSelected('execute')

      // Navigate up to the earlier step and commit it.
      await app.leftPane.selectStep('plan')

      await app.leftPane.assertStepSelected('plan')
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )

  it.skipIf(!tmuxAvailable)(
    'followLive returns the committed highlight to the live step, resending f until it lands',
    async () => {
      const app = await buildApp()
      await app.resize(80, 24)
      await app.launch({ steps: ['plan', 'execute'], stopAt: 'mid-step' })

      await app.leftPane.selectStep('plan')
      await app.leftPane.assertStepSelected('plan')

      // f snaps back to the live (running) step.
      await app.leftPane.followLive()

      await app.leftPane.assertStepSelected('execute')
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )

  it.skipIf(!tmuxAvailable)(
    'selectStep to an out-of-range step name throws a clear error instead of hanging',
    async () => {
      const app = await buildApp()
      await app.resize(80, 24)
      await app.launch({ steps: ['plan', 'execute'], stopAt: 'mid-step' })

      await expect(app.leftPane.selectStep('does-not-exist')).rejects.toThrow('no such step')
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )
})

// U5a affordances over real tmux bytes: preview cursor, scroll/viewport window,
// glyph colour. Each proves the byte-level fidelity a fake tmux cannot (R5).
describe('screen driver — U5a preview cursor, scroll, glyph colour', () => {
  it.skipIf(!tmuxAvailable)(
    'browses the preview cursor without committing the selection',
    async () => {
      const app = await buildApp()
      await app.resize(80, 24)
      await app.launch({ steps: ['plan', 'execute'], stopAt: 'mid-step' })

      await app.leftPane.assertStepSelected('execute')
      await app.leftPane.browseTo('plan')
      await app.leftPane.assertPreviewCursorOn('plan')
      await app.leftPane.assertStepSelected('execute') // committed unchanged
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )

  it.skipIf(!tmuxAvailable)(
    'scrolls an off-window step into view and back to the live tail',
    async () => {
      const app = await buildApp()
      await app.resize(80, 12)
      await app.launch({
        steps: ['a01', 'a02', 'a03', 'a04', 'a05', 'a06', 'a07', 'a08', 'a09', 'a10'],
        stopAt: 'mid-step',
      })

      await app.leftPane.assertStepOffscreen('a01')
      await app.leftPane.scrollToOldest()
      await app.leftPane.assertStepVisible('a01')
      await app.leftPane.scrollToLive()
      await app.leftPane.assertStepVisible('a10')
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )

  it.skipIf(!tmuxAvailable)(
    'renders the glyph colours so they survive real tmux (ANSI bytes)',
    async () => {
      const app = await buildApp()
      await app.resize(80, 24)
      await app.launch({ steps: ['plan', 'execute'], stopAt: 'mid-step' })

      await app.leftPane.assertGlyphColor('execute', 'running') // ◐ yellow
      await app.leftPane.assertGlyphColor('plan', 'done') // ✓ green
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )
})

// U5b affordances over real tmux: footer hints, banner paint (no TTL — D-P2),
// end-of-run summary text/count/colour.
describe('screen driver — U5b footer hints, banner paint, end-of-run summary', () => {
  it.skipIf(!tmuxAvailable)(
    'renders the live-mode footer hints',
    async () => {
      const app = await buildApp()
      await app.resize(80, 24)
      await app.launch({ steps: ['plan'], stopAt: 'mid-step' })

      await app.leftPane.assertViewStepHintVisible()
      await app.leftPane.assertHelpHintVisible()
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )

  it.skipIf(!tmuxAvailable)(
    'paints an info banner and an error banner above the steps grid',
    async () => {
      const info = await buildApp()
      await info.resize(80, 24)
      await info.launch({ steps: ['plan'], stopAt: 'mid-step', banner: { kind: 'info', text: 'saved to disk' } })
      await info.leftPane.assertInfoBannerShows('saved to disk')

      const err = await buildApp()
      await err.resize(80, 24)
      await err.launch({ steps: ['plan'], stopAt: 'mid-step', banner: { kind: 'error', text: 'disk full' } })
      await err.leftPane.assertErrorBannerShows('disk full')
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )

  it.skipIf(!tmuxAvailable)(
    'renders the end-of-run completion count and a coloured summary label',
    async () => {
      const app = await buildApp()
      await app.resize(80, 24)
      await app.launch({ steps: ['plan', 'execute'], stopAt: 'end-of-run' })

      await app.leftPane.assertCompletionCount(2, 2)
      await app.leftPane.assertSummaryColor('completed')
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )
})

// U6 help overlay over real tmux: the `?` keystroke opens the overlay bytes,
// `Esc` closes them, and the step list survives the toggle. This is the net-new
// surface U6 adds; it is proven at the driver level (open/close/survives) before
// the help-overlay scenario leans on it.
describe('screen driver — U6 help overlay over real tmux', () => {
  it.skipIf(!tmuxAvailable)(
    'opens the overlay bytes on ? and closes them on Esc',
    async () => {
      const app = await buildApp()
      await app.resize(80, 24)
      await app.launch({ steps: ['plan', 'execute'], stopAt: 'mid-step' })

      await app.leftPane.assertHelpHidden()
      await app.leftPane.openHelp()
      await app.leftPane.assertHelpVisible()

      await app.leftPane.closeHelp()
      await app.leftPane.assertHelpHidden()
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )

  it.skipIf(!tmuxAvailable)(
    'leaves every step row intact across the overlay toggle',
    async () => {
      const app = await buildApp()
      await app.resize(80, 24)
      await app.launch({ steps: ['plan', 'execute', 'review'], stopAt: 'mid-step' })

      await app.leftPane.openHelp()
      await app.leftPane.assertHelpVisible()
      await app.leftPane.closeHelp()

      await app.leftPane.assertStepListSurvives(['plan', 'execute', 'review'])
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )
})

// Real-tmux sockets land in the tmux socket dir as `orch-*`. Delta-based.
function listOrchSockets(): string[] {
  const dir = `${process.env.TMUX_TMPDIR ?? '/tmp'}/tmux-${process.getuid?.() ?? 0}`
  try {
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((name) => name.startsWith('orch-'))
      .sort()
  } catch {
    return []
  }
}
