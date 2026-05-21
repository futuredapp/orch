/**
 * `behavioral-resumable-crash` — Tier 5 fixture for Group H.
 *
 * Two puppet steps. Test scenario:
 *   - First run: `plan` completes successfully; `execute` is failed by the
 *     test via `agent('execute').fail({...})`. Run ends `crashed`.
 *   - Resume:    test relaunches against the same state base via `orch resume`
 *     with a fresh control file for `execute`. `plan` replays from cache
 *     (rendered with the `cached` glyph); `execute` re-runs and is completed.
 *
 * The fixture body is intentionally identical to `puppet-can-fail` — the
 * difference is only at the launcher (Group H test toggles the second
 * invocation to use `orch resume`).
 */

import { step, workflow } from '../../../src/core/index.ts'
import { scriptedFake } from '../../../src/runners/scripted-fake/index.ts'

const PLAN = step.define('plan', {
  agent: scriptedFake({ stepName: 'plan' }),
  prompt: 'behavioral: resumable-crash plan (puppet)',
})

const EXECUTE = step.define('execute', {
  agent: scriptedFake({ stepName: 'execute' }),
  prompt: 'behavioral: resumable-crash execute (puppet)',
})

const wf = workflow('behavioral-resumable-crash', async (run) => {
  await run(PLAN)
  await run(EXECUTE)
})

// biome-ignore lint/style/noDefaultExport: orch's loadWorkflow requires default export
export default wf
