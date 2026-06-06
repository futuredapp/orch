import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, readdirSync } from 'node:fs'
import type { ModelApp } from '../../app-surfaces.ts'
import { modelDriver } from '../model-driver.ts'

// Driver-level unit tests for the `model` driver: it must inspect the
// projected/rendered view-model, boot NO tmux, allocate NO socket, and tear
// down idempotently. These characterize the driver lifecycle BEFORE any
// behaviour migrates onto it.

const META = {
  name: 'driver-test',
  drivers: ['model'] as const,
  feature: 'driver',
  oldTestRefs: [] as const,
}

let app: ModelApp | undefined

afterEach(async () => {
  await app?.teardown()
  app = undefined
})

describe('model driver boots no tmux', () => {
  it('builds and renders without allocating any tmux socket', async () => {
    const socketsBefore = listOrchTestSockets()

    app = await modelDriver.build(META)
    await app.launch({ steps: ['plan', 'execute'], stopAt: 'mid-step' })
    await app.leftPane.assertStepSelected('execute')

    expect(listOrchTestSockets()).toEqual(socketsBefore)
  })
})

describe('model driver assertions read the projected view-model', () => {
  it('assertBottomText asserts the selected footer hint for the current state', async () => {
    app = await modelDriver.build(META)
    await app.launch({ steps: ['plan'], stopAt: 'mid-step' })

    // The live footer reads "▶ live · ⏎ view step · q quit · ? help".
    await app.leftPane.assertQuitHintVisible()
  })

  it('reflects the committed selection moving from the live step to a replayed step and back', async () => {
    app = await modelDriver.build(META)
    await app.launch({ steps: ['plan', 'execute'], stopAt: 'mid-step' })

    // Starts on the running (live) step.
    await app.leftPane.assertStepSelected('execute')

    // Selecting a past step pins the committed selection there.
    await app.leftPane.selectStep('plan')
    await app.leftPane.assertStepSelected('plan')

    // Follow-live snaps the committed selection back to the running step.
    await app.leftPane.followLive()
    await app.leftPane.assertStepSelected('execute')
  })

  it('renders the running glyph on the live step', async () => {
    app = await modelDriver.build(META)
    await app.launch({ steps: ['plan', 'execute'], stopAt: 'mid-step' })

    await app.leftPane.assertGlyph('execute', 'running')
  })
})

describe('model driver U5a preview cursor + scroll + glyph colour', () => {
  it('moves the preview cursor without committing the selection', async () => {
    app = await modelDriver.build(META)
    await app.launch({ steps: ['s1', 's2', 's3'], stopAt: 'mid-step' })

    // Committed selection starts on the live (last) step.
    await app.leftPane.assertStepSelected('s3')

    // Browsing moves only the ↑/↓ preview cursor; the committed row is unchanged.
    await app.leftPane.browseTo('s1')
    await app.leftPane.assertPreviewCursorOn('s1')
    await app.leftPane.assertStepSelected('s3')
  })

  it('scrolls an off-window step into and back out of the viewport', async () => {
    app = await modelDriver.build(META)
    await app.launch({
      steps: ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'],
      stopAt: 'mid-step',
      viewportRows: 10,
    })

    // At the live tail a small window shows the newest steps; the oldest is out.
    await app.leftPane.assertStepOffscreen('s1')

    await app.leftPane.scrollToOldest()
    await app.leftPane.assertStepVisible('s1')

    await app.leftPane.scrollToLive()
    await app.leftPane.assertStepVisible('s8')
  })

  it('renders each glyph state in its expected colour (raw SGR)', async () => {
    app = await modelDriver.build(META)
    await app.launch({ steps: ['s1', 's2'], stopAt: 'mid-step' })

    await app.leftPane.assertGlyphColor('s2', 'running') // ◐ yellow
    await app.leftPane.assertGlyphColor('s1', 'done') // ✓ green
  })
})

describe('model driver U5b banner TTL runs on the virtual clock (D-P2)', () => {
  it('auto-clears an info banner only after advanceTime, taking no real wall-clock', async () => {
    app = await modelDriver.build(META)
    await app.launch({ steps: ['s1'], stopAt: 'mid-step' })

    await app.emitBanner('info', 'saved to disk')
    await app.leftPane.assertInfoBannerShows('saved to disk')

    const startedAt = Date.now()
    await app.advanceTime(4000)
    await app.leftPane.assertBannerCleared('saved to disk')
    const elapsed = Date.now() - startedAt

    // The TTL is 4000ms of VIRTUAL time; if it had used wall-clock this would
    // have taken ~4s. Proving ≈0 real time is the whole point of D-P2.
    expect(elapsed).toBeLessThan(1000)
  })

  it('keeps an error banner up across advanceTime — it persists until dismissed', async () => {
    app = await modelDriver.build(META)
    await app.launch({ steps: ['s1'], stopAt: 'mid-step' })

    await app.emitBanner('error', 'disk full')
    await app.leftPane.assertErrorBannerShows('disk full')

    await app.advanceTime(60_000)
    await app.leftPane.assertErrorBannerShows('disk full')
  })
})

describe('model driver U5b end-of-run summary', () => {
  it('reaches a terminal completed state with a green summary and completion count', async () => {
    app = await modelDriver.build(META)
    await app.launch({ steps: ['s1', 's2', 's3'], stopAt: 'end-of-run' })

    await app.leftPane.assertCompletionCount(3, 3)
    await app.leftPane.assertSummaryColor('completed')
  })

  it('renders a red summary label on a failed run', async () => {
    app = await modelDriver.build(META)
    await app.launch({ steps: ['s1', 's2'], stopAt: 'end-of-run', outcome: 'failed' })

    await app.leftPane.assertSummaryColor('failed')
  })
})

describe('model driver U6 help overlay', () => {
  it('opens the overlay on ? and hides the view-mode footer while it is open', async () => {
    app = await modelDriver.build(META)
    await app.launch({ steps: ['plan', 'execute'], stopAt: 'mid-step' })

    await app.leftPane.assertHelpHidden()
    await app.leftPane.openHelp()
    await app.leftPane.assertHelpVisible()
  })

  it('closes the overlay on Esc and leaves the step list intact across the toggle', async () => {
    app = await modelDriver.build(META)
    await app.launch({ steps: ['plan', 'execute', 'review'], stopAt: 'mid-step' })

    await app.leftPane.openHelp()
    await app.leftPane.assertHelpVisible()

    await app.leftPane.closeHelp()
    await app.leftPane.assertHelpHidden()

    // Survival: every step row still renders after open→close.
    await app.leftPane.assertStepListSurvives(['plan', 'execute', 'review'])
  })

  it('opens and closes idempotently across repeated toggles', async () => {
    app = await modelDriver.build(META)
    await app.launch({ steps: ['plan'], stopAt: 'mid-step' })

    await app.leftPane.openHelp()
    await app.leftPane.assertHelpVisible()
    await app.leftPane.closeHelp()
    await app.leftPane.assertHelpHidden()
    await app.leftPane.openHelp()
    await app.leftPane.assertHelpVisible()
  })
})

describe('model driver teardown is idempotent', () => {
  it('can be torn down twice with no error and no new socket residue', async () => {
    const socketsBefore = listOrchTestSockets()
    const built = await modelDriver.build(META)
    await built.launch({ steps: ['plan'], stopAt: 'mid-step' })

    await built.teardown()
    await built.teardown()

    // Delta, not absolute: the legacy real-tmux suite may leave `orch-test-*`
    // sockets in the shared dir; what matters is the model driver added none.
    expect(listOrchTestSockets()).toEqual(socketsBefore)
  })
})

// Real-tmux sockets live under the tmux socket dir as `orch-*`. The model
// driver must never create one; this lists any so the tests can assert "none".
function listOrchTestSockets(): string[] {
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
