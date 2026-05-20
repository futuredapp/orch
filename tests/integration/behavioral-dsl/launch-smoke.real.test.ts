/**
 * Tier 5 launcher smoke. Boots the `two-step-linear` fixture via the orch
 * CLI as a real subprocess, observes `state.json` appear, drives a held
 * step to mid-run, releases it, watches the run complete, and tears down.
 *
 * The DSL barrel (`tests/helpers/behavioral-dsl`) is the only thing this
 * cell imports — internal harness modules stay private.
 *
 * Gated on `canRunRealTmux()`: requires `tmux` on PATH and no surrounding
 * tmux session.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import {
  holdUntilReleased,
  launchOrchWorkflow,
  type OrchHandle,
  release,
  userAction,
} from '../../helpers/behavioral-dsl/index.ts'
import { canRunRealTmux } from '../../helpers/real-tmux/fixture.ts'

let handle: OrchHandle | undefined

beforeEach(() => {
  handle = undefined
})

afterEach(async () => {
  if (handle !== undefined) {
    await handle.teardown()
  }
})

describe.skipIf(!canRunRealTmux())('Tier 5 launcher — two-step-linear smoke', () => {
  it('boots the fixture, parses runId, derives socket, and exposes the rawStreams handle', async () => {
    handle = await launchOrchWorkflow('two-step-linear', {
      script: {
        plan: { kind: 'instant-ok' },
        execute: { kind: 'instant-ok' },
      },
      bringToState: { kind: 'completed' },
    })

    expect(handle.runId).toMatch(/^r-\d{4}-\d{2}-\d{2}-\d{6}-[a-z0-9]{2}$/)
    expect(handle.socket).toBe(`orch-${handle.runId}` as typeof handle.socket)
    expect(handle.stateBase.length).toBeGreaterThan(0)
    expect(handle.stateDir).toBe(`${handle.stateBase}/${handle.runId}` as typeof handle.stateDir)
    // rawStreams: true → both raw-stream views are present.
    expect(typeof handle.subprocess.writeStdin).toBe('function')
    expect(typeof handle.subprocess.stdoutBytes).toBe('function')
    // state.json materialized inside our isolated stateBase, not the fixture dir.
    expect(existsSync(`${handle.stateDir}/state.json`)).toBe(true)
    // Subprocess has exited 0 because bringToState='completed' returns after status flip.
    const exit = await handle.subprocess.wait()
    expect(exit.exitCode).toBe(0)
  }, 30_000)

  it('drives a held step to mid-run, releases it via the gate file, and finishes', async () => {
    handle = await launchOrchWorkflow('two-step-linear', {
      script: {
        plan: holdUntilReleased(),
        execute: { kind: 'instant-ok' },
      },
      bringToState: { kind: 'mid-step', name: 'plan' },
    })

    // At this point the plan step is held by wait-for-file; state.json
    // exists, status=running, and no `value` is populated yet for plan.
    const beforeReleaseRaw = await Bun.file(`${handle.stateDir}/state.json`).text()
    const beforeRelease = JSON.parse(beforeReleaseRaw) as {
      status: string
      steps: Record<string, { value?: unknown }>
    }
    expect(beforeRelease.status).toBe('running')
    expect(beforeRelease.steps.plan?.value).toBeUndefined()

    await userAction(release('plan'))

    // After release, the workflow proceeds; wait for the subprocess to exit
    // (instant-ok × 2 with the hold gate now satisfied → orch finishes).
    const exit = await Promise.race([
      handle.subprocess.wait(),
      new Promise<{ exitCode: number }>((_res, rej) =>
        setTimeout(() => rej(new Error('subprocess did not exit within 15s')), 15_000),
      ),
    ])
    expect(exit.exitCode).toBe(0)

    const afterRaw = await Bun.file(`${handle.stateDir}/state.json`).text()
    const after = JSON.parse(afterRaw) as {
      status: string
      steps: Record<string, { endedAt?: number }>
    }
    expect(after.status).toBe('completed')
    // Both step entries persisted with endedAt → both completed end-to-end.
    expect(after.steps.plan?.endedAt).toBeGreaterThan(0)
    expect(after.steps.execute?.endedAt).toBeGreaterThan(0)
  }, 30_000)

  it('teardown is idempotent and removes the isolated stateBase', async () => {
    handle = await launchOrchWorkflow('two-step-linear', {
      script: {
        plan: { kind: 'instant-ok' },
        execute: { kind: 'instant-ok' },
      },
      bringToState: { kind: 'completed' },
    })
    const stateBase = handle.stateBase
    expect(existsSync(stateBase)).toBe(true)

    await handle.teardown()
    await handle.teardown() // second call should be a no-op
    expect(existsSync(stateBase)).toBe(false)
    handle = undefined // afterEach won't double-teardown
  }, 30_000)

  it('throws a clear error when the fixture name is not registered', async () => {
    await expect(
      launchOrchWorkflow('does-not-exist' as 'two-step-linear', {
        script: {},
      }),
    ).rejects.toThrow(/no fixture/)
  })
})
