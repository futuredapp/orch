import { holdsOpen, scenario } from '../dsl/index.ts'

// Tracer for the `lifecycle` driver (parent U2, §9.8). Proves the outside-in
// process-shutdown contract end-to-end: Ctrl-C (SIGINT) during a held step exits
// orch via a documented signal and tears the tmux appliance down cleanly.
//
// Deviation from the parent §9.8 example (recorded honestly): that example also
// asserts `persistedStatus('cancelled')`, but on current `main` neither SIGINT
// nor a `q` quit-intent persists a `cancelled` run status — the run is left at
// `running` (a pre-existing gap documented in
// tests/integration/lifecycle/sigint-to-orch-during-mid-step.real.test.ts,
// slated for triage in a later parent phase). Asserting it here would be a false
// claim, so the tracer asserts only the shutdown outcomes that hold on main. The
// `persistedStatus` assertion itself is still implemented and covered against a
// planted state in the lifecycle driver regression test.

scenario(
  {
    name: 'pressing Ctrl-C during a held step exits cleanly and tears tmux down',
    feature: 'shutdown',
    drivers: ['lifecycle'],
    risk: 'foreground-shutdown-race',
    regressionRef: '2026-05-26 real-tmux-suite-flakiness-leaked-puppets',
    oldTestRefs: [
      'tests/integration/lifecycle/sigint-to-orch-during-mid-step.real.test.ts',
    ],
  },
  async (app) => {
    // given — a held step so there is a window to act
    await app.launch({ steps: ['work'], agent: holdsOpen(), stopAt: 'mid-step' })

    // when — Ctrl-C
    await app.signal('SIGINT')

    // then — process-level outcomes via SystemAssertions
    await app.system.exitedNormally()
    await app.system.tmuxTornDown()
  },
)
