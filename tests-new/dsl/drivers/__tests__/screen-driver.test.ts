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
