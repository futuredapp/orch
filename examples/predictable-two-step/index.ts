/**
 * predictable-two-step — DEV-ONLY QA example. Do NOT ship in a published config.
 *
 * The minimal two-step linear run (`first → last`) used to QA the steps-view
 * LIVE-FOLLOW behavior: with no user keypress, the left-pane cursor must auto-
 * track the running step and auto-advance to the next step as `view` moves.
 *
 * Both steps are interactive Ink panes so each is drivable + screenshot-able.
 * `scriptedFake` is a deep import on purpose (absent from the public barrels —
 * a dev/test-only affordance).
 */

import { step, workflow } from '../../src/core/index.ts'
import { scriptedFake } from '../../src/runners/scripted-fake/index.ts'

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

export default workflow('predictable-two-step', async (run) => {
  await run(FIRST, { as: 'first' })
  await run(LAST, { as: 'last' })
})
