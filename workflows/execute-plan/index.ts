/**
 * execute-plan — drive an already-phased plan to a merge-ready state.
 *
 * Pipeline:
 *   1. count-phases   autonomous, haiku, returns { phases }
 *   2. for i in 1..phases:
 *        a. plan-<i>   autonomous, claude — /compound-engineering:ce-plan,
 *                      focused execution plan for phase i (planning only)
 *        b. work-<i>   autonomous, claude — /compound-engineering:ce-work,
 *                      implements phase i, appends a BRIEF "## Phase i"
 *                      summary to <planDir>/phase-summaries.md
 *        c. commit("phase i complete")
 *   3. finalize        autonomous, claude (no slash command) — make the
 *                      `tests-new/` suite green, confirm every `tests/` case is
 *                      ported, delete `tests/`, rename `tests-new/` → `tests/`
 *   4. commit("chore: finalize test migration …")
 *   5. verify-check    command — `bun run check` (onFailure: continue)
 *   6. if check failed: fixup autonomous, then commit
 *
 * No interactive steps and no ask() — runs under `--mode=plain` and is safe
 * under `--noninteractive`.
 *
 * Usage:
 *   bunx orch run execute-plan "docs/sessions/<slug>/plan.md"
 *
 * Requirements: `claude` on PATH; the compound-engineering plugin (ce-plan,
 * ce-work) installed. The plan file must already be phased.
 */

import * as nodePath from 'node:path'
import { claude, command, commit, schema, step, workflow, z, type Runner } from 'orch'

// Mark spawned Claude processes as sandboxed so `--dangerously-skip-permissions`
// is honored. `IS_SANDBOX` is in the Claude runner's env passthrough, so setting
// it here propagates to every step.
process.env.IS_SANDBOX = '1'

const HAIKU_MODEL = 'claude-haiku-4-5-20251001'

// Test-migration layout: old tests live under `tests/`, the migrated suite
// under `tests-new/`. Finalize removes the old dir and promotes the new one.
const OLD_TESTS_DIR = 'tests'
const NEW_TESTS_DIR = 'tests-new'

// Structural only — the 1..30 range lives in the prompt, not here.
const PHASES_SCHEMA = z.object({ phases: z.number().int() })

// Shared autonomy contract appended to every agent prompt so each sub-agent
// knows it runs unattended and must leave committing to the workflow.
const AUTONOMY =
  `\n\nYou are running autonomously inside an orchestrator — there is no human ` +
  `to answer questions, so do not ask any; make reasonable decisions and proceed. ` +
  `Do NOT run \`git commit\`, \`git stash\`, or \`git push\`, and do NOT create, ` +
  `switch, or delete git branches — leave all changes in the working tree; the ` +
  `workflow handles commits.`

/**
 * Build a claude() runner tagged with a per-step --name. `bare: false` so
 * CLAUDE.md / plugins / skills load (the ce-plan / ce-work slash commands
 * need skills resolved).
 */
function claudeFor(sessionName: string): Runner {
  return claude({
    bare: false,
    flags: ['--dangerously-skip-permissions', '--name', sessionName],
  })
}

export default workflow('execute-plan', async (run, args) => {
  const planPath = args.prompt?.trim()
  if (planPath === undefined || planPath === '') {
    throw new Error(
      'execute-plan requires the path to a phased plan file. ' +
        'Usage: orch run execute-plan "docs/sessions/<slug>/plan.md"',
    )
  }
  const planDir = nodePath.dirname(planPath)
  const summariesFile = nodePath.join(planDir, 'phase-summaries.md')

  // 1. Count the phases in the plan so we know how many loop iterations to run.
  const countPhasesStep = step.define('count-phases', {
    agent: claude({ model: HAIKU_MODEL, bare: false }),
    prompt:
      `Read the phased plan at \`${planPath}\`. Count the number of distinct ` +
      `implementation phases it defines. Return JSON \`{ "phases": <integer> }\`, ` +
      `an integer between 1 and 30. If the plan is not explicitly phased, return 1. ` +
      `Do not modify any files.${AUTONOMY}`,
    returns: schema(PHASES_SCHEMA),
  })
  const { phases } = await run(countPhasesStep)

  // 2. Per-phase loop: plan the phase, implement it, commit.
  for (let i = 1; i <= phases; i++) {
    const planStep = step.define('plan-phase', {
      agent: claudeFor(`execute-plan-plan-${i}`),
      prompt:
        `/compound-engineering:ce-plan\n` +
        `Produce a focused, actionable execution plan for PHASE ${i} (and only ` +
        `phase ${i}) of the master plan at \`${planPath}\`. Read \`${planPath}\` ` +
        `first to understand the full scope, then elaborate phase ${i} into ` +
        `concrete, ordered steps. Planning only — do NOT modify source files in ` +
        `this step. If \`${planPath}\` already spells out phase ${i} in enough ` +
        `detail, say so and stop. Read also ${summariesFile} to understand what ` +
        `has already been implemented. Previous changes are commited. ${AUTONOMY}`,
    })
    await run(planStep, { as: `plan-phase-${i}` })

    const workStep = step.define('work-phase', {
      agent: claudeFor(`execute-plan-work-${i}`),
      prompt:
        `/compound-engineering:ce-work\n` +
        `Implement PHASE ${i} (and only phase ${i}) of the plan at \`${planPath}\`. ` +
        `Read \`${planPath}\` first. Implement only phase ${i}; leave later phases ` +
        `untouched. If a previous run already completed phase ${i} in the working ` +
        `tree, do nothing and say so.\n` +
        `When done, append a BRIEF summary to \`${summariesFile}\`: a \`## Phase ${i}\` ` +
        `heading followed by 1-3 short paragrpahs in plain language — what changed ` +
        `and why. What is importantto know for next work. No file-by-file breakdown. ` +
        `Create the file if it does not exist.\n` +
        `Stop after appending the summary.${AUTONOMY}`,
    })
    await run(workStep, { as: `work-phase-${i}` })

    await run(commit(`phase ${i} complete`))
  }

  // 3. Finalize the test migration. Plain autonomous claude — no slash command.
  const finalizeStep = step.define('finalize', {
    agent: claudeFor('execute-plan-finalize'),
    prompt:
      `Finalize a test-suite migration so this branch is ready to merge. The new ` +
      `tests live under \`${NEW_TESTS_DIR}/\`; the old tests live under ` +
      `\`${OLD_TESTS_DIR}/\`; the plan at \`${planPath}\` describes the migration. ` +
      `Do these in order:\n` +
      `1. Run the new suite (\`bun test ${NEW_TESTS_DIR}\`). Fix anything failing ` +
      `or missing until it passes. Use subagents for fixing.\n` +
      `2. Confirm EVERY test under \`${OLD_TESTS_DIR}/\` has an equivalent under ` +
      `\`${NEW_TESTS_DIR}/\`. Port anything not yet covered; list what you migrated. ` +
      `Use subagents for analysis and porting.\n` +
      `3. Once coverage is complete and green: delete the \`${OLD_TESTS_DIR}/\` ` +
      `directory entirely, then rename \`${NEW_TESTS_DIR}/\` → \`${OLD_TESTS_DIR}/\`.\n` +
      `4. Update any config or paths that referenced \`${NEW_TESTS_DIR}/\` so the ` +
      `suite runs from \`${OLD_TESTS_DIR}/\`.\n` +
      `5. Run the suite once more from \`${OLD_TESTS_DIR}/\` and confirm it is green.\n` +
      `Stop when the suite is green from \`${OLD_TESTS_DIR}/\`.${AUTONOMY}`,
  })
  await run(finalizeStep)

  await run(commit('chore: finalize test migration (remove old tests, promote new suite)'))

  // 5. Verify the repo gate. `onFailure: 'continue'` so we can react below.
  const checkStep = command('verify-check', {
    argv: ['bun', 'run', 'check'],
    onFailure: 'continue',
  })
  const checkResult = await run(checkStep)

  // 6. One fixup pass if the gate is red, then commit the fix.
  if (checkResult.exitCode !== 0) {
    const fixupStep = step.define('fixup', {
      agent: claudeFor('execute-plan-fixup'),
      prompt:
        `\`bun run check\` is failing after the test migration. Read the failing ` +
        `output, fix the root cause (lint, typecheck, or test failures), and re-run ` +
        `\`bun run check\` until it passes. Stop when it is green.${AUTONOMY}`,
    })
    await run(fixupStep)

    await run(commit('fix: resolve check failures after test migration'))
  }
})
