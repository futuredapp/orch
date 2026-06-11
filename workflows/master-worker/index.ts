/**
 * master-worker — an interactive master decomposes a request into standalone
 * steps; autonomous workers execute them one-by-one inside an isolated git
 * worktree; a critic reviews the result at most twice and may add gap-closing
 * steps. One "meta" skill (`/master-worker`) governs every agent, dispatched by
 * the ROLE the workflow injects.
 *
 * Pipeline:
 *   1. master       interactive, claude  /master-worker (ROLE=master)
 *                     → asks the user what to do, then writes .orch/master-worker/plan.json
 *   2. readPlan()   in-workflow file read → typed { slug, branch, runContext, steps[] }
 *                     (deterministic JSON read + schema parse; no agent needed)
 *   3. createWorktree(branch, { enter:true })  → isolated checkout (workflow owns all git)
 *   4. for each step (SEQUENTIAL):
 *        work-<id>  autonomous, claude  /master-worker (ROLE=worker) + step.prompt
 *        commit(step.commitMessage)     when the master set one
 *   5. for iteration in 1..2 (critic loop):
 *        critic-<i> autonomous, claude  /master-worker (ROLE=critic), returns CRITIC_SCHEMA
 *        execute any gap-closing additionalSteps, then re-check; stop when satisfied
 *
 * Every agent runs on claude-opus-4-8.
 *
 * Prompt files (sibling .md):
 *   - master.md      seeds /master-worker (ROLE=master)
 *   - worker.md      /master-worker (ROLE=worker) framing; task arrives via extraPrompt
 *   - critic.md      /master-worker (ROLE=critic); original plan passed via extraContext
 *
 * Usage (the master is interactive, so two-pane mode is required):
 *   bunx orch run master-worker --mode=two-pane
 *   bunx orch run master-worker --mode=two-pane "optional seed request"
 *
 * Requirements: `claude` on PATH; a git repo (the worktree is cut from HEAD).
 */

import { readFileSync } from 'node:fs'
import { claude, commit, createWorktree, schema, step, workflow, z, type Runner } from 'orch'

// `--dangerously-skip-permissions` is only honored when IS_SANDBOX=1 is in the
// env. IS_SANDBOX is in the Claude runner's passthrough, so setting it here
// propagates to every spawned step.
process.env.IS_SANDBOX = '1'

const OPUS_MODEL = 'claude-opus-4-8'
const MAX_CRITIC_ITERATIONS = 2
const PLAN_PATH = '.orch/master-worker/plan.json'

// Structural only — value rules (kebab ids, conventional branch prefixes, the
// "empty string means no commit" convention) live in the prompt files. The
// derivation rules the old parse-plan step applied (default commitMessage/
// runContext to "", derive branch as feat/<slug>) now live in readPlan() below.
const STEP_SCHEMA = z.object({
  id: z.string(),
  name: z.string(),
  prompt: z.string(),
  commitMessage: z.string().default(''),
})

const PLAN_SCHEMA = z.object({
  slug: z.string(),
  branch: z.string().optional(),
  runContext: z.string().default(''),
  steps: z.array(STEP_SCHEMA),
})

const CRITIC_SCHEMA = z.object({
  satisfied: z.boolean(),
  reason: z.string(),
  additionalSteps: z.array(STEP_SCHEMA),
})

type PlanStep = z.infer<typeof STEP_SCHEMA>
type Plan = z.infer<typeof PLAN_SCHEMA> & { branch: string }

// Read the plan the interactive master wrote, directly from disk. A JSON read +
// schema parse is deterministic, so this is safe to call between run() steps —
// it re-runs harmlessly on resume rather than needing memoization. Replaced the
// former autonomous haiku `parse-plan` step: a model round-trip just to echo a
// file back was pure overhead. If plan.json ever proves too messy to parse
// here, reintroduce a haiku step that returns PLAN_SCHEMA.
function readPlan(): Plan {
  const parsed = PLAN_SCHEMA.parse(JSON.parse(readFileSync(PLAN_PATH, 'utf8')))
  const branch =
    parsed.branch !== undefined && parsed.branch.trim() !== ''
      ? parsed.branch
      : `feat/${parsed.slug}`
  return { ...parsed, branch }
}

function claudeFor(sessionName: string): Runner {
  return claude({
    model: OPUS_MODEL,
    bare: false,
    flags: ['--dangerously-skip-permissions', '--name', sessionName],
  })
}

const MASTER = step.define('master', {
  mode: 'interactive',
  agent: claudeFor('master-worker-master'),
  promptFile: 'master.md',
})

const WORKER = step.define('worker', {
  agent: claudeFor('master-worker-worker'),
  promptFile: 'worker.md',
})

const CRITIC = step.define('critic', {
  agent: claudeFor('master-worker-critic'),
  promptFile: 'critic.md',
  returns: schema(CRITIC_SCHEMA),
})

export default workflow('master-worker', async (run, args) => {
  // 1. Interactive master — collaborates with the user, writes plan.json. Runs
  //    on the current checkout but touches only gitignored `.orch/`.
  await run(MASTER)

  // 2. Read the master's plan.json straight off disk into a typed value — no
  //    agent round-trip. See readPlan() for why this is resume-safe.
  const plan = readPlan()
  const sessionsDir = `docs/sessions/${plan.slug}`

  // Run one plan step as a worker, then commit if the master asked for one.
  const runWorkerStep = async (planStep: PlanStep, asKey: string): Promise<void> => {
    await run(WORKER, {
      as: asKey,
      vars: {
        runContext: plan.runContext,
        sessionsDir,
        stepId: planStep.id,
        stepName: planStep.name,
      },
      extraPrompt: planStep.prompt,
    })

    if (planStep.commitMessage.trim() !== '') {
      await run(commit(planStep.commitMessage), { as: `commit-${asKey}` })
    }
  }

  // 3. Execute every planned step strictly one-by-one inside the worktree.
  for (const planStep of plan.steps) {
    await runWorkerStep(planStep, `work-${planStep.id}`)
  }

  // 4. Critic loop — at most MAX_CRITIC_ITERATIONS passes. Each pass may add
  //    gap-closing steps (never new scope); stop as soon as it is satisfied.
  for (let iteration = 1; iteration <= MAX_CRITIC_ITERATIONS; iteration++) {
    const verdict = await run(CRITIC, {
      as: `critic-${iteration}`,
      vars: { iteration, maxIterations: MAX_CRITIC_ITERATIONS, sessionsDir },
      extraContext: { originalPlan: plan },
    })

    if (verdict.satisfied || verdict.additionalSteps.length === 0) break

    for (const fix of verdict.additionalSteps) {
      await runWorkerStep(fix, `critic-${iteration}-${fix.id}`)
    }
  }
})
