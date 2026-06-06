import { holdsOpen, scenario } from '../dsl/index.ts'

// G1 (parent U8) — stdin-EOF to orch during a held step. This is the WEAK
// contract: orch v1 has no stdin-EOF handler, so closing a piped stdin does NOT
// reliably tear orch down. Re-derives `close-stdin-during-mid-step`, mirroring
// the old cell exactly — settle (inside `closeStdin`), then assert ONLY that the
// terminal escape stream stays balanced. No exit/teardown matcher is asserted
// because none is contracted; the cell documents observed behaviour.
//
// Distinct from SIGHUP: closing a piped stdin does NOT deliver SIGHUP (the
// controlling-TTY hangup path is the `sighup--*` cell).

scenario(
  {
    name: 'closing orch stdin keeps the terminal balanced (weak contract)',
    feature: 'shutdown',
    drivers: ['lifecycle'],
    risk: 'foreground-shutdown-race',
    oldTestRefs: ['tests/integration/lifecycle/close-stdin-during-mid-step.real.test.ts'],
  },
  async (app) => {
    // given — a held step so there is a window to act
    await app.launch({ steps: ['work'], agent: holdsOpen(), stopAt: 'mid-step' })

    // when — close stdin (settles internally before the weak assertion)
    await app.closeStdin()

    // then — only the weak invariant: the terminal stays balanced
    await app.system.terminalRestoredCleanly()
  },
)
