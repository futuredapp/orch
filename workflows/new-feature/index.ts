/**
 * new-feature — turn a one-line feature idea into a brainstorm + plan pair
 * under `docs/sessions/<slug>/`.
 *
 * Pipeline:
 *   1. generate-slug   autonomous, haiku, returns { slug }
 *   2. (inline)        mkdir -p docs/sessions/<slug>
 *   3. brainstorm      interactive, runs /workflows:brainstorm with the
 *                      original prompt + session-management instructions
 *   4. plan            autonomous, runs /compound-engineering:workflows:plan
 *                      to analyse the brainstorm and produce a plan in the
 *                      same session directory
 *   5. plan-review     autonomous, runs /compound-engineering:plan_review on
 *                      the produced plan, then integrates whichever of its
 *                      recommendations stay faithful to the original
 *                      brainstorm
 *   6. work loop       up to MAX_WORK_ITERATIONS (5) passes of:
 *                      a. work-<i>          /compound-engineering:workflows:work
 *                                           on phase 1 only, no commits, no
 *                                           branch switches
 *                      b. check-done-<i>    haiku, returns { done, reason };
 *                                           breaks the loop on done:true
 *   7. review          autonomous, runs /compound-engineering:workflows:review
 *                      and writes `<sessionsDir>/review.md` with detailed
 *                      findings
 *
 * Usage:
 *   bunx orch run new-feature "what I want to build"
 *
 * Notes:
 *   - Interactive brainstorm requires `--mode=two-pane` (the default when a
 *     TTY + tmux are present). `--mode=plain` will fail at the brainstorm
 *     step with the documented `ViewResolutionError`.
 */

import { mkdir } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { z } from 'zod'
import { schema, step, workflow } from '../../src/core/index.ts'
import { claude } from '../../src/runners/index.ts'
import type { Runner } from '../../src/runners/index.ts'

// Mark the spawned Claude processes as sandboxed so they're willing to run
// with `--dangerously-skip-permissions`. `IS_SANDBOX` is in the Claude
// runner's env passthrough, so setting it here propagates to every step.
process.env.IS_SANDBOX = '1'

const HAIKU_MODEL = 'claude-haiku-4-5-20251001'

const MAX_WORK_ITERATIONS = 5

const SLUG_SCHEMA = z.object({
  slug: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z][a-z0-9-]*$/, 'slug must be lowercase kebab-case'),
})

const PHASE_DONE_SCHEMA = z.object({
  done: z.boolean(),
  reason: z.string().min(1).max(500),
})

function claudeFor(sessionName: string): Runner {
  return claude({
    bare: false,
    flags: ['--dangerously-skip-permissions', '--name', sessionName],
  })
}

export default workflow('new-feature', async (run, args) => {
  if (args.prompt === undefined || args.prompt.trim() === '') {
    throw new Error(
      'new-feature requires a prompt. Usage: orch run new-feature "what I want to build"',
    )
  }
  const userPrompt = args.prompt.trim()

  // 1. Slug — short, kebab-case, deterministic-ish folder name for this session.
  const slugStep = step.define('generate-slug', {
    agent: claude({ model: HAIKU_MODEL, bare: false }),
    prompt:
      'Read this feature idea and return a 2-4 word kebab-case slug that names the session. ' +
      'Lowercase a-z, digits, and hyphens only. No leading digit. No trailing hyphen.\n\n' +
      `Idea:\n${userPrompt}`,
    returns: schema(SLUG_SCHEMA),
  })
  const { slug } = await run(slugStep)

  // 2. Make the session directory so subsequent steps don't race on it.
  const sessionsDir = nodePath.join('docs', 'sessions', slug)
  await mkdir(sessionsDir, { recursive: true })

  const sessionContext =
    `\n\nSession management:\n` +
    `Store every artefact you produce (brainstorm, plan, notes, scratch) under \`${sessionsDir}/\`. ` +
    `The directory already exists. Use stable filenames like \`brainstorm.md\` and \`plan.md\` so ` +
    `later steps in this workflow can find them.`

  // 3. Brainstorm — interactive, user drives the session. On exit, workflow resumes.
  const brainstormStep = step.define('brainstorm', {
    mode: 'interactive',
    agent: claudeFor(`${slug}-brainstorm`),
    prompt: `/workflows:brainstorm ${userPrompt}${sessionContext}`,
  })
  await run(brainstormStep)

  // 4. Plan — autonomous review + plan over whatever the brainstorm produced.
  const planStep = step.define('plan', {
    agent: claudeFor(`${slug}-plan`),
    prompt:
      `/compound-engineering:workflows:plan ` +
      `Analyse and plan the brainstorm written under \`${sessionsDir}/\`. ` +
      `Read every file in that directory first, then produce \`${sessionsDir}/plan.md\` with ` +
      `a phased implementation plan derived from the brainstorm.${sessionContext}`,
  })
  await run(planStep)

  // 5. Plan review — run the plan_review skill on the freshly produced plan,
  //    then fold in any recommendations that stay faithful to the brainstorm.
  const planReviewStep = step.define('plan-review', {
    agent: claudeFor(`${slug}-plan-review`),
    prompt:
      `/compound-engineering:plan_review ` +
      `Review the plan at \`${sessionsDir}/plan.md\` against the brainstorm under ` +
      `\`${sessionsDir}/\`. First read every file in that directory (especially ` +
      `\`brainstorm.md\` and \`plan.md\`) so you understand both the original intent ` +
      `and the proposed plan. ` +
      `Then run the plan_review skill to surface gaps, risks, and improvements. ` +
      `Finally, edit \`${sessionsDir}/plan.md\` in place to integrate every ` +
      `recommendation that strengthens the plan WITHOUT contradicting or expanding ` +
      `the scope established in the brainstorm. Drop or note (do not silently ` +
      `apply) any recommendation that would break the original brainstorm's intent. ` +
      `Append a short \`## Plan review\` section at the end of \`plan.md\` ` +
      `summarising which recommendations were integrated and which were rejected, ` +
      `each with a one-line reason.${sessionContext}`,
  })
  await run(planReviewStep)

  // 6. Work loop — drive phase 1 of the plan to completion. Each iteration
  //    runs the `work` skill (no commits, no branch switches) and then asks
  //    a cheap haiku judge whether phase 1 is finished. Capped at
  //    MAX_WORK_ITERATIONS so a stuck plan can't loop forever.
  for (let i = 1; i <= MAX_WORK_ITERATIONS; i++) {
    const workStep = step.define(`work-${i}`, {
      agent: claudeFor(`${slug}-work-${i}`),
      prompt:
        `/compound-engineering:workflows:work ` +
        `Implement PHASE 1 (and only phase 1) of the plan at \`${sessionsDir}/plan.md\`. ` +
        `Read \`${sessionsDir}/plan.md\` and \`${sessionsDir}/brainstorm.md\` first so you ` +
        `understand the intent. ` +
        `Hard constraints: ` +
        `(1) stay on the current git branch — do NOT create, switch, or delete branches; ` +
        `(2) do NOT run \`git commit\`, \`git stash\`, \`git push\`, or any command that ` +
        `mutates git history — leave all changes in the working tree only; ` +
        `(3) if phase 1 already looks complete in the working tree, do nothing and say so. ` +
        `Make as much progress on phase 1 as you can in this single session. ` +
        `If a previous iteration of this loop already started phase 1, continue from where ` +
        `it left off rather than restarting.${sessionContext}`,
    })
    await run(workStep)

    const checkDoneStep = step.define(`check-phase1-done-${i}`, {
      agent: claude({ model: HAIKU_MODEL, bare: false }),
      prompt:
        `Decide whether PHASE 1 of the plan is fully implemented. ` +
        `Read \`${sessionsDir}/plan.md\` to see what phase 1 requires, then inspect the ` +
        `repository working tree (uncommitted changes are expected — there are no commits ` +
        `for this work) to judge whether every checklist item / task under phase 1 has ` +
        `been done. ` +
        `Return JSON matching the schema: { "done": boolean, "reason": string }. ` +
        `Set \`done: true\` only when every phase-1 task is implemented; otherwise ` +
        `\`done: false\` with a short reason naming what is still missing.`,
      returns: schema(PHASE_DONE_SCHEMA),
    })
    const { done } = await run(checkDoneStep)
    if (done) break
  }

  // 7. Review — final pass that produces a detailed review document.
  const reviewStep = step.define('review', {
    agent: claudeFor(`${slug}-review`),
    prompt:
      `/compound-engineering:workflows:review ` +
      `Review the phase-1 implementation that currently sits in the working tree (no ` +
      `commits were made — inspect uncommitted changes via \`git status\` and \`git diff\`). ` +
      `Cross-reference the changes against \`${sessionsDir}/plan.md\` and ` +
      `\`${sessionsDir}/brainstorm.md\`. ` +
      `Write your full findings to \`${sessionsDir}/review.md\`. The file MUST contain a ` +
      `detailed description of: what was implemented, what is missing or wrong, code-quality ` +
      `concerns, deviations from the plan / brainstorm, risks, and concrete follow-up ` +
      `recommendations. Stop after writing \`review.md\` — do not start fixing anything ` +
      `and do not commit.${sessionContext}`,
  })
  await run(reviewStep)
})
