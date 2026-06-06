import { claudeAgent, scenario } from '../../dsl/index.ts'

// Gated smoke for the `full-host:real-agent` driver — the port of the legacy
// tier-4 autonomous multi-step case (parent U9/W2, §9.7). The ONLY difference
// from the §9.5 fake-agent body is a REAL ClaudeRunner in the agent slot — the
// swap IS the promotion (D-P3.3). It proves the binary integrates INSIDE the
// two-pane system across MULTIPLE steps (pane painting), not the runner in
// isolation (§5.6).
//
// Auto-skips unless `tmux` + `claude` are on PATH and RUN_REAL_TMUX_E2E=1;
// reachable ONLY via `bun run test:two-pane:full:real` (D8). Never on `check`.

scenario(
  {
    name: 'two real Claude steps run to completion and the transcript paints in the right pane',
    feature: 'real-cli-smoke',
    drivers: ['full-host:real-agent'],
    oldTestRefs: ['tests/e2e/tier-4/autonomous-multi-step.real.e2e.test.ts'],
  },
  async (app) => {
    // given — a real ClaudeRunner driving two autonomous steps. The DSL applies
    // one agent spec to every step, so both reply the same word; two steps prove
    // multi-step completion and the second step's transcript reaching the pane.
    await app.launch({ steps: ['plan', 'work'], agent: claudeAgent('Reply with exactly: kiwi') })

    // when — both steps run to completion
    await app.complete('work')

    // then — live transcript text reached the visible right pane
    await app.rightPane.assertShowsContent('kiwi')
  },
)
