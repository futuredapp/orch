/**
 * predictable-tui — DEV-ONLY example. Do NOT ship this in a published config.
 *
 * Demonstrates the predictable fake agent (`scriptedFake`) as a runner you can
 * drive during development: a deterministic stand-in for `claude()` / `codex()`
 * that takes input from TWO channels routed through ONE engine —
 *
 *   1. manual typing into its tmux pane (input + Enter), and
 *   2. an external script / QA agent appending NDJSON commands to its on-disk
 *      control file (see `drive.ts`).
 *
 * Both render identically, so a human and a script are interchangeable drivers.
 *
 * WHY DEV-ONLY: `scriptedFake` is deliberately absent from the public barrels
 * (`src/index.ts`, `src/runners/index.ts`) and the package is `private`, so it
 * can never be imported by a published consumer. This example deep-imports it
 * from its own module barrel (`src/runners/scripted-fake/index.ts`), which is
 * allowed under CLAUDE.md rule 7 (one barrel PER module) but is a deliberate
 * signal: predictable-fake is a development/test affordance, not a product
 * runner.
 *
 * Every step is INTERACTIVE — a live PTY pane rendered with the Ink list+input
 * TUI (`interactiveUi: 'ink'`), so each step echoes what you type and is a
 * drivable, screenshot-able surface. There is no headless step and therefore no
 * `ORCH_LIFECYCLE_SCRIPT` to set: the interactive entry has exactly one
 * behavior (live puppet) and reads no script file.
 *
 * RUNNING IT
 *     bunx orch run predictable-tui --mode=two-pane
 *
 *   Then drive each step EITHER by hand (type a line + Enter to send; `exit`/`q`
 *   to end the step) OR, in a second terminal, drive the whole run with:
 *
 *     bun examples/predictable-tui/drive.ts
 */

import { step, workflow } from '../../src/core/index.ts'
// Deep import: scriptedFake is intentionally NOT in the public runners barrel.
import { scriptedFake } from '../../src/runners/scripted-fake/index.ts'

// One runner per step (interactive is frozen at construction). `stepName` binds
// each runner to its row; `as:` (set via the `run` overrides) becomes the
// run-time key a driver addresses. `interactiveUi: 'ink'` selects the Ink
// list+input pane over the raw line-printer.
const ink = (stepName: string) => scriptedFake({ stepName, interactive: true, interactiveUi: 'ink' })

const PLAN = step.define('plan', {
  mode: 'interactive',
  agent: ink('plan'),
  prompt: 'Draft a plan. Type a line + Enter, or let drive.ts send one.',
})

const EXECUTE = step.define('execute', {
  mode: 'interactive',
  agent: ink('execute'),
  prompt: 'Execute the plan. Same two drive channels as the plan step.',
})

const REPORT = step.define('report', {
  mode: 'interactive',
  agent: ink('report'),
  prompt: 'Summarize the run. Same two drive channels.',
})

export default workflow('predictable-tui', async (run) => {
  await run(PLAN, { as: 'plan' })
  await run(EXECUTE, { as: 'execute' })
  await run(REPORT, { as: 'report' })
})
