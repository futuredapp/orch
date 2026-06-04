/**
 * TEMPLATE — copy into `examples/<your-name>/index.ts`, rename, then register in
 * `examples/orch.config.ts`. A DEV-ONLY predictable-fake workflow you can drive
 * with the QA toolkit (`examples/qa/qa.ts`).
 *
 * Keep every step `mode: 'interactive'` with `interactiveUi: 'ink'` so it is a
 * drivable, screenshot-able PTY pane. `scriptedFake` is a deep import on purpose
 * (it is absent from the public barrels — a dev/test-only affordance).
 *
 * To exercise a subworkflow, uncomment the `runWorkflow` block and add a sibling
 * sub file modeled on this one (its own `workflow('<sub-name>', …)` default
 * export). The sub's steps will be addressable as `<sub-name>>stepKey` — discover
 * the exact keys at runtime with `bun examples/qa/qa.ts awaiting --cwd examples`.
 */

import { /* runWorkflow, */ step, workflow } from '../../src/core/index.ts'
import { scriptedFake } from '../../src/runners/scripted-fake/index.ts'
// import deepDive from './deep-dive.ts' // ← your sub's default export

const ink = (stepName: string) => scriptedFake({ stepName, interactive: true, interactiveUi: 'ink' })

const FIRST = step.define('first', {
  mode: 'interactive',
  agent: ink('first'),
  prompt: 'First step. Drive me with `qa send` or simulate typing with `qa keys`.',
})

const LAST = step.define('last', {
  mode: 'interactive',
  agent: ink('last'),
  prompt: 'Last step. Same two drive channels.',
})

// Rename 'qa-template' to your workflow name (also used in orch.config.ts).
export default workflow('qa-template', async (run) => {
  await run(FIRST, { as: 'first' })
  // await runWorkflow(deepDive, {}) // ← enters a subworkflow here
  await run(LAST, { as: 'last' })
})
