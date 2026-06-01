/**
 * feature — parent dispatching to one of two subworkflows.
 *
 * Runs a `decide` step that classifies `args.prompt` as `simple` or `complex`,
 * then dispatches via `runWorkflow` to the matching subworkflow file. Both
 * subs declare the same `Args` shape so the parent's `args` can be forwarded
 * verbatim.
 *
 * This is the canonical extraction shape — the dispatch step stays in the
 * parent, the per-branch step chains live in their own files, and the parent
 * stays readable.
 */

import { z } from 'zod'
import { runWorkflow, schema, step, workflow, type WorkflowArgs } from '../../src/core/index.ts'
import { claude } from '../../src/runners/index.ts'
import complexFeature from '../complex-feature/index.ts'
import simpleFeature from '../simple-feature/index.ts'

const DECISION_SCHEMA = schema(
  z.object({
    type: z.enum(['simple', 'complex']),
  }),
)

const DECIDE = step.define('decide', {
  agent: claude({ bare: false, flags: ['--dangerously-skip-permissions'] }),
  prompt: `Classify the request as "simple" (one or two files) or "complex" (multi-step, design needed). Reply ONLY with JSON matching the output schema. Request: {{prompt}}`,
  returns: DECISION_SCHEMA,
})

export default workflow('feature', async (run, args) => {
  const prompt = args.prompt ?? ''
  const decision = await run(DECIDE, { vars: { prompt } })
  const subArgs: WorkflowArgs & { prompt: string } = { prompt }
  if (decision.type === 'simple') {
    await runWorkflow(simpleFeature, subArgs)
  } else {
    await runWorkflow(complexFeature, subArgs)
  }
})
