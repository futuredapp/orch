import { holdsOpen, scenario } from '../dsl/index.ts'

// G1 (parent U8) — SIGHUP to orch during a held step. SIGHUP is what a real
// controlling-TTY hangup delivers when the user closes the terminal window (the
// "I closed my terminal" recovery path). Re-derives
// `sighup-to-orch-during-mid-step` asserting the shutdown invariants `main`
// produces (KD2) — no `persistedStatus('cancelled')`.

scenario(
  {
    name: 'SIGHUP during a held step exits cleanly and tears tmux down',
    feature: 'shutdown',
    drivers: ['lifecycle'],
    risk: 'foreground-shutdown-race',
    oldTestRefs: ['tests/integration/lifecycle/sighup-to-orch-during-mid-step.real.test.ts'],
  },
  async (app) => {
    // given — a held step so there is a window to act
    await app.launch({ steps: ['work'], agent: holdsOpen(), stopAt: 'mid-step' })

    // when
    await app.signal('SIGHUP')

    // then
    await app.system.exitedNormally()
    await app.system.tmuxTornDown()
    await app.system.terminalRestoredCleanly()
    await app.system.noOrphanChildren()
  },
)
