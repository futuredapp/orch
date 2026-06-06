import { claudeAgent, scenario } from '../../dsl/index.ts'

// Gated smoke for the `full-host:real-agent` driver — the port of the legacy
// tier-4 interactive auto-stop case (AE2; parent U9/W2). It is the ONLY layer
// that exercises the real inline-hook injection + real env inheritance + real
// tmux `wait-for` transport that the fake cannot reproduce: a finished
// interactive turn closes the pane with NO keystroke. The interactive/autoStop
// passthrough (W1) makes this expressible at all.
//
// Auto-skips unless `tmux` + `claude` are on PATH and RUN_REAL_TMUX_E2E=1;
// reachable ONLY via `bun run test:two-pane:full:real` (D8). Never on `check`.

scenario(
  {
    name: 'an interactive auto-stop step finishes its turn and the pane closes with no keystroke',
    feature: 'real-cli-smoke',
    drivers: ['full-host:real-agent'],
    oldTestRefs: ['tests/e2e/tier-4/auto-stop.real.e2e.test.ts'],
  },
  async (app) => {
    // given — a single interactive step set to auto-stop when its turn finishes
    await app.launch({
      steps: ['brainstorm'],
      agent: claudeAgent('Reply with exactly the word "done" and nothing else.'),
      mode: 'interactive',
      autoStop: true,
    })

    // when — the turn finishes; the real Stop hook fires `tmux wait-for` and orch
    // closes the pane, so `complete` resolves with NO keystroke ever sent.
    await app.complete('brainstorm')

    // then — the reply painted in the right pane: the turn actually ran + finished
    await app.rightPane.assertShowsContent('done')
  },
)
