/**
 * complex-feature — typed-Args subworkflow with a longer step chain.
 *
 * The contrast pair to `simple-feature`. Same `Args` shape so both are
 * interchangeable from a dispatching parent (see `examples/feature`). The
 * extra `design` step in front pads the chain so the dispatcher's branch
 * choice is visible in the two-pane projector.
 */

import { step, workflow, type WorkflowArgs } from '../../src/core/index.ts'
import { claude } from '../../src/runners/index.ts'

export interface ComplexFeatureArgs extends WorkflowArgs {
  readonly prompt: string
}

const DESIGN = step.define('design', {
  agent: claude({ bare: false, flags: ['--dangerously-skip-permissions'] }),
  prompt: 'Sketch a more thorough design for: {{prompt}}',
})

const PLAN = step.define('plan', {
  agent: claude({ bare: false, flags: ['--dangerously-skip-permissions'] }),
  prompt: 'Plan the implementation steps from the design.',
})

const IMPLEMENT = step.define('implement', {
  agent: claude({ bare: false, flags: ['--dangerously-skip-permissions'] }),
  prompt: 'Implement the plan.',
})

const VERIFY = step.define('verify', {
  agent: claude({ bare: false, flags: ['--dangerously-skip-permissions'] }),
  prompt: 'Run the verification suite and summarise the outcome.',
})

export default workflow<ComplexFeatureArgs>('complex-feature', async (run, args) => {
  await run(DESIGN, { vars: { prompt: args.prompt } })
  await run(PLAN)
  await run(IMPLEMENT)
  await run(VERIFY)
})
