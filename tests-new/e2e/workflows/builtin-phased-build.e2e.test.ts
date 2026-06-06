// Tier 4 e2e — the packaged built-ins (`orch::work-cc`, `orch::work-codex`)
// driven against REAL CLIs through a real tmux host. Env-gated and developer-
// opt-in (`RUN_REAL_TMUX_E2E=1` + the CLI on PATH); auto-skips in normal CI, so
// these are NOT part of `bun run check`.
//
// Two distinct things are proven here that the Tier 1 / integration suites
// cannot:
//   1. work-cc: the real decide step writes a parseable phase artifact end-to-
//      end — the agent actually adheres to the delimiter contract (R-2 smoke).
//   2. work-codex: the Codex autoStop setup path (per-run CODEX_HOME injection)
//      actually closes a finished turn unattended. Structural config-equality
//      tests share a recording runner and therefore say NOTHING about whether
//      Codex's autoStop transport works (R-6 / per-runner divergence).

import { describe, expect, it } from 'bun:test'
import type { WorkflowDeps } from '../../../src/core/index.ts'
import { claude, codex } from '../../../src/runners/index.ts'
import { FakeGitService, path } from '../../../src/services/index.ts'
import { FakePromptService } from '../../../src/services/prompt/index.ts'
import { ARTIFACT_PATH } from '../../../src/workflows/phased-build/decide-prompt.ts'
import { parsePhases } from '../../../src/workflows/phased-build/parse-phases.ts'
import { buildPhasedWorkflow } from '../../../src/workflows/phased-build/pipeline.ts'
import {
  canRunRealTmuxE2E,
  createRealTmuxFixture,
  type MountedHarness,
  mountTmuxHost,
  type RealTmuxFixture,
} from '@orch/test/real-tmux/index.ts'

const ARTIFACT = ARTIFACT_PATH

let fixturesToDispose: RealTmuxFixture[] = []
let harnessesToTeardown: MountedHarness[] = []

async function cleanup(): Promise<void> {
  for (const h of harnessesToTeardown) await h.teardown()
  harnessesToTeardown = []
  for (const f of fixturesToDispose) await f.dispose()
  fixturesToDispose = []
}

// Construct the full WorkflowDeps the built-in executor needs from the fixture +
// mounted host. Mirrors the real-tmux workflow-driver's internal deps, which it
// does not expose for arbitrary executors.
function depsFor(
  fixture: RealTmuxFixture,
  harness: MountedHarness,
  name: string,
  prompt: string,
): WorkflowDeps {
  return {
    stateStore: harness.stateStore,
    processService: fixture.processService,
    clock: fixture.clock,
    runId: fixture.runId,
    cwd: fixture.stateBase,
    fsService: fixture.fs,
    gitService: new FakeGitService(),
    host: harness.host,
    promptService: new FakePromptService(),
    interactivity: 'interactive',
    logger: harness.logger,
    workflowName: name,
    args: { prompt },
  }
}

describe.skipIf(!canRunRealTmuxE2E('claude'))('Tier 4 — orch::work-cc (real Claude)', () => {
  it('the decide step writes a parseable phase artifact for a tiny plan', async () => {
    const fixture = await createRealTmuxFixture({ env: {} })
    fixturesToDispose.push(fixture)
    const harness = await mountTmuxHost(fixture, { disableStepsView: false })
    harnessesToTeardown.push(harness)

    const plan =
      'Add a single CHANGELOG.md file with one line. This is one tiny, single-concern change.'
    const executor = buildPhasedWorkflow(
      'work-cc',
      claude({ bare: false, flags: ['--dangerously-skip-permissions'] }),
    )

    // We assert on the decide artifact (the deterministic R-2 contract), not on
    // the whole implement loop completing — a real agent implementing phases is
    // inherently slow/variable. A mid-loop throw still leaves the artifact the
    // decide step produced, which is what this smoke proves.
    try {
      await executor.execute(depsFor(fixture, harness, 'work-cc', plan))
    } catch {
      // Tolerated: see comment above — the artifact assertion below is the gate.
    }

    const artifactPath = path(`${fixture.stateBase}/${ARTIFACT}`)
    expect(await fixture.fs.exists(artifactPath)).toBe(true)
    const phases = parsePhases(await fixture.fs.readFile(artifactPath))
    expect(phases.length).toBeGreaterThanOrEqual(1)

    await cleanup()
  }, 180_000)
})

describe.skipIf(!canRunRealTmuxE2E('codex'))(
  'Tier 4 — orch::work-codex autoStop setup (real Codex)',
  () => {
    it('finishes an interactive turn and the pane closes on its own with no keystroke', async () => {
      const fixture = await createRealTmuxFixture({ env: {} })
      fixturesToDispose.push(fixture)
      const harness = await mountTmuxHost(fixture, {
        disableStepsView: false,
        agentProcessService: fixture.processService,
      })
      harnessesToTeardown.push(harness)

      // The work-codex runner posture (sandbox: 'full-auto'). Exercises the real
      // per-run CODEX_HOME injection the codex variant relies on for autoStop —
      // the path that can fail where the Claude variant succeeds.
      const result = await harness.runWorkflow([
        {
          name: 'decide-phases',
          agent: codex({ sandbox: 'full-auto' }),
          mode: 'interactive',
          autoStop: true,
          prompt: 'Reply with exactly the word "done" and nothing else.',
        },
      ])

      expect(result.completed).toBe(true)

      await cleanup()
    }, 120_000)
  },
)
