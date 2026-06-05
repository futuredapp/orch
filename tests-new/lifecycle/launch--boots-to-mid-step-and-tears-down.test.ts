import { holdsOpen, scenario } from '../dsl/index.ts'

// Migration (parent U4.5, K4). The LIFECYCLE half of the launch behavioral
// tests: a multi-step workflow boots, lands mid-step (the last step running),
// and tears the tmux appliance down cleanly on shutdown. Per the decision rule
// (parent §6), the RENDERING assertions of the old launch behavioral tests
// (header/glyph/footer) DEMOTE to `screen` + `model`; the lifecycle concern is
// pure PROCESS behaviour — boot + teardown — so this scenario reads NO panes
// (lifecycle subprocess-snapshot pane reads stay deferred to U8).
//
// Honest deviation (carried from the U2 tracer): `persistedStatus('cancelled')`
// is a pre-existing `main` gap on shutdown, so it is NOT asserted here.

scenario(
  {
    name: 'a multi-step launch boots to a running mid-step and tears tmux down on shutdown',
    feature: 'launch',
    drivers: ['lifecycle'],
    risk: 'launch-boot-teardown',
    regressionRef: '2026-05-26 real-tmux-suite-flakiness-leaked-puppets',
    oldTestRefs: [
      'tests/integration/lifecycle/launch.workflow-header-and-step-list-render.behavioral.real.test.ts',
      'tests/integration/lifecycle/launch.first-step-is-running-and-highlighted.behavioral.real.test.ts',
    ],
  },
  async (app) => {
    // given — a two-step launch held at its last (running) step
    await app.launch({ steps: ['plan', 'execute'], agent: holdsOpen(), stopAt: 'mid-step' })

    // when — the run is shut down from the foreground
    await app.signal('SIGINT')

    // then — process-level outcomes only (no pane reads, K4)
    await app.system.exitedNormally()
    await app.system.tmuxTornDown()
  },
)
