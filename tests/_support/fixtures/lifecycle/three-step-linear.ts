/**
 * `behavioral-three-step-linear` — Tier 5 fixture for Batch 1 progression /
 * navigation cells. Three autonomous puppet-driven steps in sequence.
 */

import { step, workflow } from '../../../../src/core/index.ts'
import { scriptedFake } from '../../../../src/runners/scripted-fake/index.ts'

const PLAN = step.define('plan', {
  agent: scriptedFake({ stepName: 'plan' }),
  prompt: 'behavioral: plan (puppet-driven)',
})

const EXECUTE = step.define('execute', {
  agent: scriptedFake({ stepName: 'execute' }),
  prompt: 'behavioral: execute (puppet-driven)',
})

const FINALIZE = step.define('finalize', {
  agent: scriptedFake({ stepName: 'finalize' }),
  prompt: 'behavioral: finalize (puppet-driven)',
})

const wf = workflow('behavioral-three-step-linear', async (run) => {
  await run(PLAN)
  await run(EXECUTE)
  await run(FINALIZE)
})

// biome-ignore lint/style/noDefaultExport: orch's loadWorkflow requires default export
export default wf
