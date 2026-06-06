// ---------------------------------------------------------------------------
// full-host:real-agent driver — the actual binary in the agent slot (U3, gated).
// ---------------------------------------------------------------------------
//
// Reuses the SAME shared static full-host engine (`createStaticFullHostApp`) as
// the fake/recorded drivers; the ONLY difference is a REAL `ClaudeRunner` /
// `CodexRunner` in the agent slot (parent §9.7, D-P3.3) — the swap IS the
// promotion, not a copy-paste. It asserts pane integration (the binary works
// INSIDE the two-pane system), not the runner in isolation (§5.6).
//
// Gated by `canRunRealTmuxE2E` (tmux + the CLI on PATH + RUN_REAL_TMUX_E2E=1);
// reachable ONLY by naming its path via `test:two-pane:full:real` (D8). On an
// incapable box it auto-skips — never a false failure.

import {
  canRunRealTmuxE2E,
  createRealTmuxFixture,
  mountTmuxHost,
} from '@orch/test/real-tmux/index.ts'
import type { Runner } from '../../../src/runners/index.ts'
import { claude, codex } from '../../../src/runners/index.ts'
import type { DriverName, FullHostApp, FullHostSpec } from '../app-surfaces.ts'
import type { ScenarioMeta } from '../scenario.ts'
import { createStaticFullHostApp } from './full-host-static-app.ts'
import type { Driver } from './registry.ts'

const DRIVER_LABEL = 'full-host:real-agent'

// A real CLI turn is far slower than a fake; budget generously (the fake budget
// is REAL_TMUX_TEST_TIMEOUT_MS=30s — too tight for a live model round-trip).
const REAL_AGENT_TIMEOUT_MS = 120_000

function realRunner(which: 'claude' | 'codex'): Runner {
  return which === 'claude' ? claude() : codex({})
}

async function build(_meta: ScenarioMeta<readonly DriverName[]>): Promise<FullHostApp> {
  const fixture = await createRealTmuxFixture({ env: {} })
  try {
    // No agentProcessService override → the agent runs on the fixture's real
    // BunProcessService, so the actual CLI binary spawns.
    const harness = await mountTmuxHost(fixture, {})

    return createStaticFullHostApp({
      fixture,
      harness,
      label: DRIVER_LABEL,
      agentForStep: (_name, _index, spec: FullHostSpec) => {
        if (spec.agent?.kind !== 'real-agent') {
          throw new Error(
            `${DRIVER_LABEL}: launch spec's agent must be claudeAgent(...)/codexAgent(...); got ` +
              `${spec.agent?.kind ?? 'undefined'}.`,
          )
        }
        return { agent: realRunner(spec.agent.runner), prompt: spec.agent.prompt }
      },
    })
  } catch (err) {
    await fixture.dispose()
    throw err
  }
}

export const fullHostRealAgentDriver: Driver<FullHostApp> = {
  build,
  // Reachable only when the E2E gate is on AND claude is on PATH. All current
  // real-agent scenarios use claudeAgent; a Codex-only machine must skip.
  skip: () => !canRunRealTmuxE2E('claude'),
  timeout: REAL_AGENT_TIMEOUT_MS,
}
