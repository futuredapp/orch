import { holdsOpen, scenario } from '../dsl/index.ts'

// G1 (parent U8; originally the U2 lifecycle tracer) — SIGINT (Ctrl-C) to orch
// during a held step exits via a documented signal and tears the tmux appliance
// down cleanly. Re-derives `sigint-to-orch-during-mid-step`.
//
// Deviation, recorded honestly (KD2): the parent §9.8 example also asserts
// `persistedStatus('cancelled')`, but on current `main` neither SIGINT nor a `q`
// quit-intent persists a `cancelled` run status — the run is left `running` (a
// pre-existing gap documented in the old sigint cell and confirmed in Phase 2).
// Asserting it here would be a false claim, so this asserts only the shutdown
// invariants `main` produces. `persistedStatus` itself stays covered against a
// planted state in the lifecycle driver regression test. Source unchanged (U8
// non-goal).

scenario(
  {
    name: 'pressing Ctrl-C during a held step exits cleanly and tears tmux down',
    feature: 'shutdown',
    drivers: ['lifecycle'],
    risk: 'foreground-shutdown-race',
    regressionRef: '2026-05-26 real-tmux-suite-flakiness-leaked-puppets',
    oldTestRefs: ['tests/integration/lifecycle/sigint-to-orch-during-mid-step.real.test.ts'],
  },
  async (app) => {
    // given — a held step so there is a window to act
    await app.launch({ steps: ['work'], agent: holdsOpen(), stopAt: 'mid-step' })

    // when — Ctrl-C
    await app.signal('SIGINT')

    // then — the shutdown invariants main produces
    await app.system.exitedNormally()
    await app.system.tmuxTornDown()
    await app.system.terminalRestoredCleanly()
    await app.system.noOrphanChildren()
  },
)
