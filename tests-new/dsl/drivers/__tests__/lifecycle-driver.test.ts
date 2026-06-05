import { existsSync, readdirSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'bun:test'
import { selectStep, userAction } from '@orch/test/behavioral-dsl/index.ts'
import {
  canRunRealTmux,
  REAL_TMUX_ASSERT_TIMEOUT_MS,
  REAL_TMUX_TEST_TIMEOUT_MS,
  scriptedFakeEntryCount,
} from '@orch/test/real-tmux/index.ts'
import { holdsOpen } from '../../agent-spec.ts'
import type { DriverName, LifecycleApp } from '../../app-surfaces.ts'
import type { ScenarioMeta } from '../../scenario.ts'
import { lifecycleDriver } from '../lifecycle-driver.ts'

// Driver-level regression tests for the `lifecycle` driver. They characterize
// the fragile outside-in lifecycle — detached-server reaping, poll-and-resend,
// no leaked puppets — BEFORE any behaviour migrates. This driver carries the two
// named historical flakes (2026-05-26 leaked puppets, 2026-05-29 nav.f-snaps).
// Lifecycle runs SERIALLY (the behavioral-dsl current-handle is process-global).

const tmuxAvailable = canRunRealTmux()

const META: ScenarioMeta<readonly DriverName[]> = {
  name: 'driver-test',
  drivers: ['lifecycle'],
  feature: 'driver',
  oldTestRefs: [],
}

let apps: LifecycleApp[] = []

afterEach(async () => {
  for (const app of apps) await app.teardown().catch(() => {})
  apps = []
})

describe('lifecycle driver — real-tmux subprocess lifecycle', () => {
  it.skipIf(!tmuxAvailable)(
    'reaps the detached orch server + socket on teardown and leaves no leaked puppets',
    async () => {
      const socketsBefore = listOrchSockets()
      const leakBefore = await scriptedFakeEntryCount()

      const app = await lifecycleDriver.build(META)
      apps.push(app)
      await app.launch({ steps: ['work'], agent: holdsOpen(), stopAt: 'mid-step' })

      expect(listOrchSockets().length).toBeGreaterThan(socketsBefore.length)

      await app.signal('SIGINT')
      await app.system.exitedNormally()

      await app.teardown()

      // Detached server reaped + socket removed; zero leaked scripted-fake
      // entries above baseline (REGRESSION 2026-05-26 leaked-puppets).
      expect(listOrchSockets()).toEqual(socketsBefore)
      expect(await scriptedFakeEntryCount()).toBe(leakBefore)
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )

  it('budgets the test with REAL_TMUX_TEST_TIMEOUT_MS and honours the distinct assert budget', () => {
    expect(lifecycleDriver.timeout).toBe(REAL_TMUX_TEST_TIMEOUT_MS)
    expect(REAL_TMUX_TEST_TIMEOUT_MS).not.toBe(5_000)
    expect(REAL_TMUX_ASSERT_TIMEOUT_MS).not.toBe(5_000)
    expect(REAL_TMUX_ASSERT_TIMEOUT_MS).not.toBe(REAL_TMUX_TEST_TIMEOUT_MS)
  })

  it('skips itself on a box without real tmux (predicate prevents false failure, never causes a run)', () => {
    expect(lifecycleDriver.skip()).toBe(!canRunRealTmux())
  })
})

describe('lifecycle driver — idempotent key poll-and-resend', () => {
  it.skipIf(!tmuxAvailable)(
    'resends f until the selection snaps back to the live step (defeats the dropped-first-keypress race)',
    async () => {
      const app = await lifecycleDriver.build(META)
      apps.push(app)
      // `plan` completes, `execute` is held live → there IS a live edge to snap to.
      await app.launch({ steps: ['plan', 'execute'], agent: holdsOpen(), stopAt: 'mid-step' })

      // Navigate away from the live edge to a completed step…
      await userAction(selectStep('plan'))
      // …then snap back. `press('left','f')` returns only once the selection is
      // observed on the live step — poll-and-resend is what makes that reliable.
      // A single dropped keypress (the 2026-05-29 regression) would make this
      // throw on exhausted attempts.
      await app.press('left', 'f')
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )
})

describe('lifecycle driver — persisted status assertion', () => {
  it.skipIf(!tmuxAvailable)(
    'reads the persisted run status and fails when it differs from the expected one',
    async () => {
      const app = await lifecycleDriver.build(META)
      apps.push(app)
      // No hold → the single step runs to completion, persisting status=completed.
      await app.launch({ steps: ['work'] })

      // Positive: the persisted status is read correctly.
      await app.system.persistedStatus('completed')

      // Negative: a wrong expectation goes red (fail-fast on a terminal status).
      await expect(app.system.persistedStatus('cancelled')).rejects.toThrow(/persistedStatus/)
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
