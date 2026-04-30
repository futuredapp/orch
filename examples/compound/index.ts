/**
 * compound — turn a plain-English prompt into a full compound-engineering cycle.
 *
 * Pipeline:
 *   1. generate-slug       autonomous, haiku, typed return { slug }
 *   2. brainstorm          interactive, opus — runs /workflows/brainstorm
 *   3. document-review     autonomous — runs /document-review
 *   4. plan                autonomous — runs /compound-engineering:workflows:plan
 *   5. deepen-plan         autonomous — runs /compound-engineering:deepen-plan
 *   6. count-phases        autonomous, haiku, typed return { phases }
 *   7. phase-1..phase-N    autonomous, one step per phase
 *
 * All session files land under `<cwd>/docs/sessions/<slug>/` so they travel
 * together. Every Claude invocation runs with `--dangerously-skip-permissions
 * --remote-control --name <slug>-<step>` and `IS_SANDBOX=1` in env.
 *
 * Usage:
 *   bunx orch run compound "what I want to build"
 *
 * Caveats:
 *   - `--remote-control` is included because the user asked for it, but it may
 *     not be a top-level flag in every Claude version (2.1.107 only exposes
 *     `claude remote-control` as a subcommand and
 *     `--remote-control-session-name-prefix` as a flag). If Claude rejects it,
 *     remove it from `PER_STEP_FLAGS` below.
 *   - Slash commands in autonomous mode depend on the Claude CLI resolving
 *     skills inside `-p` / `--print`. If a step returns no structured output,
 *     check `claude --disable-slash-commands` semantics.
 *   - Interactive brainstorm under `--mode=two-pane` takes the right pane
 *     via `tmux respawn-pane -k`; autonomous steps stream a readable
 *     transcript in the same pane. `--mode=plain` errors on the interactive
 *     step with the documented `ViewResolutionError`.
 */

import * as nodePath from 'node:path'
import { z } from 'zod'
import { schema, step, workflow } from '../../src/core/index.ts'
import { claude } from '../../src/runners/index.ts'
import type { Runner } from '../../src/runners/index.ts'

// Signal sandboxed execution to Claude. `IS_SANDBOX` is in the Claude runner's
// env allowlist, so setting it on `process.env` here propagates to every
// spawned step via buildClaudeEnv.
process.env.IS_SANDBOX = '1'

const HAIKU_MODEL = 'claude-haiku-4-5-20251001'

const SLUG_SCHEMA = z.object({
  slug: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z][a-z0-9-]*$/, 'slug must be lowercase kebab-case'),
})

const PHASES_SCHEMA = z.object({
  phases: z.number().int().min(1).max(30),
})

/**
 * Build a claude() runner tagged with a per-step --name. Includes the
 * dangerous + remote-control flags the caller asked for. `bare: false` so
 * CLAUDE.md / plugins / skills all load (slash commands need skills).
 */
function claudeFor(sessionName: string, opts: { readonly model?: string } = {}): Runner {
  const flags: string[] = [
    '--dangerously-skip-permissions',
    '--remote-control',
    '--name',
    sessionName,
  ]
  return claude({
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    bare: false,
    flags,
  })
}

export default workflow('compound', async (run, args) => {
  if (args.prompt === undefined || args.prompt.trim() === '') {
    throw new Error(
      'compound requires a prompt. Usage: orch run compound "what I want to build"',
    )
  }
  const userPrompt = args.prompt

  // 1. Generate a short kebab-case slug for this session.
  const slugStep = step.define('generate-slug', {
    agent: claude({ model: HAIKU_MODEL, bare: false }),
    prompt:
      'Read this project idea and return a 2-4 word kebab-case slug that names the session. ' +
      'Keep it short, lowercase, a-z0-9 and hyphens only, no leading digit.\n\n' +
      `Idea:\n${userPrompt}`,
    returns: schema(SLUG_SCHEMA),
  })
  const { slug } = await run(slugStep)
  const sessionsDir = nodePath.join('docs', 'sessions', slug)

  const sharedContext =
    `\n\n` +
    `Extra instructions:\n` +
    `Analyze content of the brainstorm and plan files and add any additional instructions to the plan file. ` +
    `Store all session files (brainstorms, plans, notes) under \`${sessionsDir}/\`. ` +
    'Create the directory if it does not exist. All subsequent steps of this ' +
    'workflow will read from the same directory.'

  // 2. Interactive brainstorm — user drives the Claude session. On exit, the
  //    workflow resumes.
  const brainstormStep = step.define('brainstorm', {
    mode: 'interactive',
    agent: claudeFor(`${slug}-brainstorm`),
    prompt: `/workflows:brainstorm\n\n${sharedContext}`,
  })
  await run(brainstormStep)

  // 4. Plan.
  const planStep = step.define('plan', {
    agent: claudeFor(`${slug}-plan`),
    prompt: `/workflows:plan\n\n${sharedContext}`,
  })
  await run(planStep)

  // 5. Deepen the plan.
  const deepenPlanStep = step.define('deepen-plan', {
    agent: claudeFor(`${slug}-deepen-plan`),
    prompt: `/deepen-plan \n\n${sharedContext}`,
  })
  await run(deepenPlanStep)

  // 6. Count the phases produced by the plan.
  const countPhasesStep = step.define('count-phases', {
    agent: claude({ model: HAIKU_MODEL, bare: false }),
    prompt:
      `Read every file under \`${sessionsDir}/\` (plan, deepened plan, brainstorm) ` +
      'and count the number of distinct implementation phases present. ' +
      'Return a single integer in `phases`. If the plan is not phased, return 1.',
    returns: schema(PHASES_SCHEMA),
  })
  const { phases } = await run(countPhasesStep)

  for (let i = 1; i <= phases; i++) {
    const phaseName = `phase-${i}`
    const phaseStep = step.define('execute-phase', {
      agent: claudeFor(`${slug}-${phaseName}`),
      prompt:
        `/workflows:plan\n\n` +
        `Execute phase ${i} of the plan in \`${sessionsDir}/\`. ` +
        'Work autonomously; do not ask questions. Commit when complete. ' +
        `Read the plan files, implement only phase ${i}, and leave subsequent phases for later invocations.`,
    })
    await run(phaseStep, { as: phaseName })
  }
})
