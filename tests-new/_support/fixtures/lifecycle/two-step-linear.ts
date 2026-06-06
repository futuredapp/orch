/**
 * `tier5-two-step-linear` — first Tier 5 fixture workflow.
 *
 * Two autonomous steps (`plan` then `execute`) both wired to
 * `ScriptedFakeRunner`. Per-step behavior is driven externally via the
 * `ORCH_LIFECYCLE_SCRIPT` JSON file (see
 * `src/runners/scripted-fake/types.ts`). The fixture itself takes NO
 * arguments — the launcher writes the script JSON, the runner reads it.
 *
 * Boot path:
 *   bun src/cli/main.ts run tier5-two-step-linear --mode=two-pane --no-attach
 *
 * This file is exported as `default` so `orch run` resolves the workflow
 * through the fixture's `.orch/orch.config.ts`.
 *
 * NOTE (parent U11 / PD2): this is a `_support` COPY of
 * `tests/fixtures/lifecycle/two-step-linear.ts`. The original is kept in place
 * for the directory-resolving runtime consumer (`workflow-fixtures.ts`
 * `FIXTURES_DIR`) and the `.orch/orch.config.ts` CLI boot path; the relocated
 * in-process smoke test imports THIS copy via `@orch/test/*` (D13). Because the
 * `_support` copy sits one directory deeper, its `src/` imports use the
 * `@orch/*` aliases rather than relative paths.
 */

import { step, workflow } from '@orch/core/index.ts'
import { scriptedFake } from '@orch/runners/scripted-fake/index.ts'

const PLAN = step.define('plan', {
  agent: scriptedFake({ stepName: 'plan' }),
  prompt: 'tier5: plan step (scripted-fake, driven by ORCH_LIFECYCLE_SCRIPT)',
})

const EXECUTE = step.define('execute', {
  agent: scriptedFake({ stepName: 'execute' }),
  prompt: 'tier5: execute step (scripted-fake, driven by ORCH_LIFECYCLE_SCRIPT)',
})

const wf = workflow('tier5-two-step-linear', async (run) => {
  await run(PLAN)
  await run(EXECUTE)
})

// biome-ignore lint/style/noDefaultExport: orch's loadWorkflow loader requires a default export
export default wf
