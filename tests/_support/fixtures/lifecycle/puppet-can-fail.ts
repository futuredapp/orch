/**
 * `behavioral-puppet-can-fail` — Tier 5 fixture for Group E (failure cells).
 *
 * Two puppet steps. The test drives `plan` to complete and `execute` to fail
 * via `handle.agent('execute').fail({ message: 'boom' })`. After execute
 * fails, the run is `crashed`, `plan` is `completed`, `execute` has no entry
 * (failure does not persist via saveStep — see workflow.ts:1235-1252), and
 * the left pane should show the ✗ glyph + an error banner mentioning the
 * failure message.
 */

import { step, workflow } from '../../../../src/core/index.ts'
import { scriptedFake } from '../../../../src/runners/scripted-fake/index.ts'

const PLAN = step.define('plan', {
  agent: scriptedFake({ stepName: 'plan' }),
  prompt: 'behavioral: puppet-can-fail plan (puppet)',
})

const EXECUTE = step.define('execute', {
  agent: scriptedFake({ stepName: 'execute' }),
  prompt: 'behavioral: puppet-can-fail execute (puppet)',
})

const wf = workflow('behavioral-puppet-can-fail', async (run) => {
  await run(PLAN)
  await run(EXECUTE)
})

// biome-ignore lint/style/noDefaultExport: orch's loadWorkflow requires default export
export default wf
