import { holdsOpen, scenario } from '../dsl/index.ts'

// G1 (parent U8) — a `quit` intent fired by the steps-view daemon during a held
// step must tear orch down cleanly (regression for origin §2.1). Re-derives
// `q-during-fake-mid-step`. The intent is injected via `tui-intents.ndjson`
// (the path `app.quitIntent()` uses) because an external `send-keys q` is
// unreliable before Ink claims raw mode — the bug under test lives in the
// parent's foreground-shutdown race, not in Ink's input handling.

scenario(
  {
    name: 'a quit intent during a held step tears orch down cleanly',
    feature: 'shutdown',
    drivers: ['lifecycle'],
    risk: 'foreground-shutdown-race',
    oldTestRefs: ['tests/integration/lifecycle/q-during-fake-mid-step.real.test.ts'],
  },
  async (app) => {
    // given — a held step so there is a window to act
    await app.launch({ steps: ['work'], agent: holdsOpen(), stopAt: 'mid-step' })

    // when — the daemon's quit intent
    await app.quitIntent()

    // then — orch exits and the tmux appliance is gone (§6.5 pane-q-during-run)
    await app.system.exitedNormally()
    await app.system.tmuxTornDown()
  },
)
