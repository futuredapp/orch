import { claudeAgent, scenario } from '../../dsl/index.ts'

// Gated smoke for the `full-host:real-agent` driver (parent U3, §9.7). The ONLY
// difference from the §9.5 fake-agent body is a REAL ClaudeRunner in the agent
// slot — the swap IS the promotion (D-P3.3). It proves the binary integrates
// INSIDE the two-pane system (pane painting), not the runner in isolation (§5.6).
//
// Auto-skips unless `tmux` + `claude` are on PATH and RUN_REAL_TMUX_E2E=1;
// reachable ONLY via `bun run test:two-pane:full:real` (D8). Never on `check`.

scenario(
  {
    name: 'a real Claude step produces output that paints in the right pane',
    feature: 'real-cli-smoke',
    drivers: ['full-host:real-agent'],
    oldTestRefs: ['tests/e2e/tier-4'],
  },
  async (app) => {
    // given — the real ClaudeRunner in the agent slot
    await app.launch({ steps: ['plan'], agent: claudeAgent('Reply with exactly: OK') })

    // when
    await app.complete('plan')

    // then — prove the binary integrates inside the two-pane system
    await app.rightPane.assertShowsContent('OK')
  },
)
