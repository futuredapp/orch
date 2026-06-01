/**
 * simple-feature — typed-Args subworkflow.
 *
 * Declares `Args = { prompt: string }` (extends WorkflowArgs) so it can be:
 *   - Run top-level via `bunx orch run simple-feature "..."` (CLI passes args.prompt).
 *   - Composed inside another workflow via `runWorkflow(simpleFeature, args)`.
 *
 * The body is two autonomous Claude steps. Step names (`plan`, `implement`)
 * collide with `complex-feature`'s step names by design — the sub-aware step
 * cache key (`simple-feature>plan` vs `complex-feature>plan`) keeps them
 * distinct so both can run from the same parent without tripping R20.
 */

import { step, workflow, type WorkflowArgs } from '../../src/core/index.ts'
import { claude } from '../../src/runners/index.ts'

export interface SimpleFeatureArgs extends WorkflowArgs {
  readonly prompt: string
}

const PLAN = step.define('plan', {
  agent: claude({ bare: false, flags: ['--dangerously-skip-permissions'] }),
  prompt: 'Outline a small plan for: {{prompt}}',
})

const IMPLEMENT = step.define('implement', {
  agent: claude({ bare: false, flags: ['--dangerously-skip-permissions'] }),
  prompt: 'Implement the plan from the previous step.',
})

export default workflow<SimpleFeatureArgs>('simple-feature', async (run, args) => {
  await run(PLAN, { vars: { prompt: args.prompt } })
  await run(IMPLEMENT)
})
