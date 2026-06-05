import { existsSync, readdirSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'bun:test'
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
