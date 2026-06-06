import { holdsOpen, scenario } from '../dsl/index.ts'

// G1 (parent U8) — a second redundant SIGINT while orch is already tearing down
// is harmless: the shutdown invariants still hold. Re-derives
// `double-sigint-to-orch-during-mid-step`, guarding against a future regression
// where a double signal wedges the handler. Asserts only what `main` does (KD2).

scenario(
  {
    name: 'a redundant second SIGINT still reaches a clean shutdown',
    feature: 'shutdown',
    drivers: ['lifecycle'],
    risk: 'foreground-shutdown-race',
    oldTestRefs: ['tests/integration/lifecycle/double-sigint-to-orch-during-mid-step.real.test.ts'],
  },
  async (app) => {
    // given — a held step so there is a window to act
    await app.launch({ steps: ['work'], agent: holdsOpen(), stopAt: 'mid-step' })

    // when — two SIGINTs in a row
    await app.signal('SIGINT')
    await app.signal('SIGINT')

    // then — the same clean state holds despite the redundant signal
    await app.system.exitedNormally()
    await app.system.tmuxTornDown()
    await app.system.terminalRestoredCleanly()
    await app.system.noOrphanChildren()
  },
)
