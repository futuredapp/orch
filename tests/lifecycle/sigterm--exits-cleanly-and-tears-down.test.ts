import { holdsOpen, scenario } from '../dsl/index.ts'

// G1 (parent U8) — SIGTERM to orch during a held step. Re-derives
// `sigterm-to-orch-during-mid-step` as a `lifecycle` scenario asserting only the
// shutdown invariants `main` actually produces (KD2): clean exit, tmux torn
// down, terminal balanced, no orphans. NO `persistedStatus('cancelled')` — on
// current `main` no signal/quit persists a `cancelled` status (Phase 2 finding;
// source unchanged per the U8 non-goal), so asserting it would be a false claim.

scenario(
  {
    name: 'SIGTERM during a held step exits cleanly and tears tmux down',
    feature: 'shutdown',
    drivers: ['lifecycle'],
    risk: 'foreground-shutdown-race',
    oldTestRefs: ['tests/integration/lifecycle/sigterm-to-orch-during-mid-step.real.test.ts'],
  },
  async (app) => {
    // given — a held step so there is a window to act
    await app.launch({ steps: ['work'], agent: holdsOpen(), stopAt: 'mid-step' })

    // when
    await app.signal('SIGTERM')

    // then — only what main actually does
    await app.system.exitedNormally()
    await app.system.tmuxTornDown()
    await app.system.terminalRestoredCleanly()
    await app.system.noOrphanChildren()
  },
)
