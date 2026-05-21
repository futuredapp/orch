/**
 * `behavioral-ask-with-default` — Tier 5 fixture for Group D #15.
 *
 * One ask step with `defaultWhenNoninteractive: { button: 'continue' }`
 * followed by a puppet step. Launched with `--noninteractive`, the ask is
 * resolved to the default without blocking; the puppet step then runs and
 * the test asserts both steps reach `completed`.
 */

import { ask, step, workflow } from '../../../src/core/index.ts'
import { scriptedFake } from '../../../src/runners/scripted-fake/index.ts'

const ASK = ask({
  name: 'continue',
  question: 'Continue?',
  buttons: ['continue', 'abort'],
  defaultWhenNoninteractive: { button: 'continue' },
})

const AFTER = step.define('after', {
  agent: scriptedFake({ stepName: 'after' }),
  prompt: 'behavioral: ask-with-default after (puppet)',
})

const wf = workflow('behavioral-ask-with-default', async (run) => {
  await run(ASK)
  await run(AFTER)
})

// biome-ignore lint/style/noDefaultExport: orch's loadWorkflow requires default export
export default wf
