import { existsSync, readdirSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'bun:test'
import {
  canRunRealTmux,
  REAL_TMUX_ASSERT_TIMEOUT_MS,
  REAL_TMUX_TEST_TIMEOUT_MS,
  scriptedFakeEntryCount,
} from '@orch/test/real-tmux/index.ts'
import { emits, live } from '../../agent-spec.ts'
import type { FullHostApp } from '../../app-surfaces.ts'
import type { DriverName } from '../../app-surfaces.ts'
import type { ScenarioMeta } from '../../scenario.ts'
import { fullHostFakeAgentDriver } from '../full-host-fake-agent-driver.ts'

// Driver-level regression tests for the `full-host:fake-agent` driver. These
// characterize the fragile real-tmux LIFECYCLE — unique socket, server reaping,
// no leaked puppets — BEFORE any behaviour migrates onto the driver. This
// boundary is where every historical flake lived (parent R1; the leaked-puppet
// pileup, docs/solutions/real-tmux-suite-flakiness-leaked-puppets.md).

const tmuxAvailable = canRunRealTmux()

const STATIC_META: ScenarioMeta<readonly DriverName[]> = {
  name: 'driver-test',
  drivers: ['full-host:fake-agent'],
  feature: 'driver',
  oldTestRefs: [],
}
const LIVE_META: ScenarioMeta<readonly DriverName[]> = { ...STATIC_META, liveDriven: true }

let apps: FullHostApp[] = []

afterEach(async () => {
  // Idempotent: app.teardown is guarded, so an explicit teardown in a test plus
  // this safety-net call do not double-reap.
  for (const app of apps) await app.teardown().catch(() => {})
  apps = []
})

describe('full-host:fake-agent driver — real-tmux lifecycle', () => {
  it.skipIf(!tmuxAvailable)(
    'allocates a unique socket on build and removes it on teardown, leaving no leaked puppets',
    async () => {
      const socketsBefore = listOrchSockets()
      const leakBefore = await scriptedFakeEntryCount()

      const app = await fullHostFakeAgentDriver.build(STATIC_META)
      apps.push(app)
      await app.launch({ steps: ['plan'], agent: emits('hello') })
      await app.complete('plan')

      // While live, exactly one new orch socket exists.
      expect(listOrchSockets().length).toBeGreaterThan(socketsBefore.length)

      await app.teardown()

      // Server reaped + socket file removed: back to the starting set.
      expect(listOrchSockets()).toEqual(socketsBefore)
      // Zero leaked scripted-fake entries above baseline (static has none, but
      // teardown must still not leave residue).
      expect(await scriptedFakeEntryCount()).toBe(leakBefore)
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )

  it('budgets the test with REAL_TMUX_TEST_TIMEOUT_MS, not Bun’s 5s default', () => {
    expect(fullHostFakeAgentDriver.timeout).toBe(REAL_TMUX_TEST_TIMEOUT_MS)
    // The two real-tmux budgets are distinct knobs and neither is the 5s default
    // (parent §12 names both; the pane driver waits on the ASSERT budget).
    expect(REAL_TMUX_TEST_TIMEOUT_MS).not.toBe(5_000)
    expect(REAL_TMUX_ASSERT_TIMEOUT_MS).not.toBe(5_000)
    expect(REAL_TMUX_ASSERT_TIMEOUT_MS).not.toBe(REAL_TMUX_TEST_TIMEOUT_MS)
  })

  it('skips itself on a box without real tmux (predicate prevents false failure, never causes a run)', () => {
    expect(fullHostFakeAgentDriver.skip()).toBe(!canRunRealTmux())
  })
})

describe('full-host:fake-agent driver — static default reaches the right pane', () => {
  it.skipIf(!tmuxAvailable)(
    'scripted text reaches the right pane after complete(step) with no caret echo',
    async () => {
      const app = await fullHostFakeAgentDriver.build(STATIC_META)
      apps.push(app)

      await app.launch({ steps: ['plan'], agent: emits('first thinking', 'second thinking') })
      await app.complete('plan')

      await app.rightPane.assertShowsContent('first thinking')
      await app.rightPane.assertNoCaretEcho()
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )
})

describe('full-host:fake-agent driver — live submode is reachable only by explicit opt-in', () => {
  it.skipIf(!tmuxAvailable)(
    'exposes app.agent only when meta.liveDriven is true',
    async () => {
      const staticApp = await fullHostFakeAgentDriver.build(STATIC_META)
      apps.push(staticApp)
      expect(staticApp.agent).toBeUndefined()

      const liveApp = await fullHostFakeAgentDriver.build(LIVE_META)
      apps.push(liveApp)
      expect(liveApp.agent).toBeDefined()
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )

  it.skipIf(!tmuxAvailable)(
    'drives the live puppet via app.agent (control channel acks) and tears down with no leaked entries',
    async () => {
      const leakBefore = await scriptedFakeEntryCount()
      const app = await fullHostFakeAgentDriver.build(LIVE_META)
      apps.push(app)

      await app.launch({ steps: ['plan'], agent: live() })
      // app.agent is gated on liveDriven; narrow it explicitly.
      const agent = app.agent
      if (agent === undefined) throw new Error('expected app.agent on a live build')

      // `type` resolves only once the puppet is ready and ACKs the command —
      // a durable on-disk signal that the live control channel is wired (parent
      // §12 / Tier-5 findings: gate on the ack, not a pane scrape). The full
      // mid-stream interleave + right-pane content is deferred to U4/U6.
      await agent.type('live thinking')

      // teardown asserts no leaked puppets internally; an unreaped puppet would
      // throw here, failing the test loudly (the R1 sentinel).
      await app.teardown()
      expect(await scriptedFakeEntryCount()).toBe(leakBefore)
    },
    REAL_TMUX_TEST_TIMEOUT_MS,
  )
})

// Real-tmux sockets land in the tmux socket dir as `orch-*`. Delta-based, not
// absolute: the legacy suite may leave `orch-test-*` sockets behind.
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
