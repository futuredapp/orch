/**
 * feature — the full compound-engineering feature cycle, end to end.
 *
 * Pipeline:
 *   0. require-codex     command, `codex --version` (hard precondition)
 *   1. slug              autonomous claude(haiku)  → { slug }
 *   2. mkdir docs/sessions/<slug>(/work,/blockers,/issues)
 *   3. brainstorm        interactive claude  /ce-brainstorm        → brainstorm.md
 *   4. acceptance        interactive claude  /orch-acceptance-tests → acceptance-tests.md
 *   5. doc-review        interactive claude  /ce-doc-review         → doc-review.md
 *   6. refine loop       ask "ok | refine"; each refine reopens brainstorm+acceptance
 *                        (the refine agent asks the user what is wrong)
 *   7. plan              autonomous claude  /ce-plan (1-4 phases)   → plan.md            [blocker]
 *   8. plan-review       autonomous codex   critique the plan       → plan-review.md
 *   9. plan-apply        autonomous claude  fold sensible findings  → plan.md            [blocker]
 *  10. impl loop (<=8)   /ce-work next phase; the work agent itself returns
 *                        { artifactPath, done, reason }; loop breaks on done   → work/impl-phase-<i>.md [blocker]
 *  11. dual review       parallel(/ce-code-review, codex /review)    → code-review-ce.md + code-review-codex.md [blocker]
 *  12. triage            autonomous claude  select fixes + write issues/ files → fix-plan.md
 *  13. fix loop (<=8)    /ce-work next group; same { done } return    → work/fix-group-<i>.md [blocker]
 *  14. green gate (<=3)  `bun run check`; on failure a fix agent     → check-report.md
 *
 * Blocker protocol: plan, plan-apply, work, and code-review steps may raise a
 * critical blocker by writing `docs/sessions/<slug>/blockers/<step>.md`. After
 * each such step the orchestrator checks for that file and, if present, runs an
 * interactive blocker-review session so the user can resolve it before the
 * workflow continues.
 *
 * Every agent prompt has `session-context.md` appended (shared-session rules +
 * the per-step artifact it must write); blocker-capable steps also get
 * `blockers.md`. The orchestrator owns ALL commits (`commit()` after each step)
 * and stays on the current branch; agents are told never to commit/push/switch.
 *
 * Usage:
 *   bunx orch run feature --mode=two-pane "what I want to build"
 *
 * Preconditions: `claude` and `codex` on PATH; the brainstorm/acceptance/doc-review/
 * refine/blocker-review steps are interactive, so `--mode=plain` fails with
 * ViewResolutionError. The green gate is hardcoded to `bun run check`.
 */

import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { z } from 'zod'
import {
  ask,
  command,
  commit,
  loadPrompt,
  parallel,
  schema,
  step,
  tail,
  workflow,
} from '../../src/core/index.ts'
import type { RunFn } from '../../src/core/index.ts'
import { claude, codex } from '../../src/runners/index.ts'
import type { Runner } from '../../src/runners/index.ts'

// `--dangerously-skip-permissions` is only honored when IS_SANDBOX=1 is in the
// env; setting it here propagates to every spawned Claude step.
process.env.IS_SANDBOX = '1'

const HAIKU_MODEL = 'claude-haiku-4-5-20251001'

const MAX_REFINE = 5
const MAX_WORK = 8
const MAX_FIX_WORK = 8
const MAX_CHECK = 3

// Structural only — value rules (kebab-case, length) live in the prompt.
const SLUG_SCHEMA = z.object({ slug: z.string() })

// The work agent reports its own progress instead of a separate done-judge.
const WORK_SCHEMA = z.object({
  artifactPath: z.string(),
  done: z.boolean(),
  reason: z.string(),
})

// --- helpers ----------------------------------------------------------------

/** A sandboxed Claude runner tagged with a per-step --name (loads plugins/skills). */
function claudeFor(sessionName: string): Runner {
  return claude({
    bare: false,
    flags: ['--dangerously-skip-permissions', '--name', sessionName],
  })
}

/** An autonomous Codex runner allowed to write to the workspace. */
function codexAuto(): Runner {
  return codex({ sandbox: 'workspace-write' })
}

/**
 * Compose a step's prompt: the per-step body, then the optional blocker
 * protocol (when the step is allowed to halt the workflow), then the shared
 * session-context fragment (no-commit rules + the exact artifact to produce).
 */
function stepPrompt(opts: {
  readonly bodyFile: string
  readonly bodyVars: Record<string, string>
  readonly sessionsDir: string
  readonly artifactName: string
  readonly blockerLabel?: string
}): string {
  const parts = [loadPrompt(opts.bodyFile, opts.bodyVars)]
  if (opts.blockerLabel !== undefined) {
    parts.push(
      loadPrompt('blockers.md', {
        sessionsDir: opts.sessionsDir,
        blockerFile: `${opts.blockerLabel}.md`,
      }),
    )
  }
  parts.push(
    loadPrompt('session-context.md', {
      sessionsDir: opts.sessionsDir,
      artifactName: opts.artifactName,
    }),
  )
  return parts.join('\n\n')
}

/**
 * If the step labelled `label` raised a blocker (wrote blockers/<label>.md),
 * run an interactive review session so the user resolves it before continuing.
 */
async function handleBlocker(
  run: RunFn,
  sessionsDir: string,
  slug: string,
  label: string,
): Promise<void> {
  const blockerPath = nodePath.join(sessionsDir, 'blockers', `${label}.md`)
  if (!existsSync(blockerPath)) return

  const reviewStep = step.define('blocker-review', {
    mode: 'interactive',
    agent: claudeFor(`${slug}-blocker-${label}`),
    prompt: loadPrompt('blocker-review.md', { blockerPath, sessionsDir }),
  })
  await run(reviewStep, { as: `blocker-review-${label}` })
  await run(commit(`docs(${slug}): blocker review ${label}`))
}

/** Post-brainstorm confirmation: proceed to planning, or run another refinement pass. */
const SPEC_OK = ask({
  name: 'spec-ok',
  question: 'Is the brainstorm + acceptance spec good enough to plan? Choose refine to iterate.',
  buttons: ['ok', 'refine'],
  defaultWhenNoninteractive: { button: 'ok' },
})

/**
 * The shared work loop used for both implementation (over plan.md phases) and
 * fixes (over fix-plan.md groups). Each round: run /ce-work on the next un-done
 * unit (the agent returns whether everything is done), commit, then resolve any
 * blocker the agent raised. Stops when the agent reports done.
 */
async function runWorkLoop(
  run: RunFn,
  opts: {
    readonly max: number
    readonly label: string
    readonly bodyFile: string
    readonly artifactPrefix: string
    readonly sessionsDir: string
    readonly slug: string
  },
): Promise<void> {
  for (let i = 1; i <= opts.max; i++) {
    const workStep = step.define(opts.label, {
      agent: claudeFor(`${opts.slug}-${opts.label}-${i}`),
      prompt: stepPrompt({
        bodyFile: opts.bodyFile,
        bodyVars: { sessionsDir: opts.sessionsDir },
        sessionsDir: opts.sessionsDir,
        artifactName: `${opts.artifactPrefix}-${i}.md`,
        blockerLabel: `${opts.label}-${i}`,
      }),
      returns: schema(WORK_SCHEMA),
    })
    const { done } = await run(workStep, { as: `${opts.label}-${i}` })
    await run(commit(`chore(${opts.slug}): ${opts.label} round ${i}`))
    await handleBlocker(run, opts.sessionsDir, opts.slug, `${opts.label}-${i}`)
    if (done) break
  }
}

// --- workflow ---------------------------------------------------------------

export default workflow('feature', async (run, args) => {
  if (args.prompt === undefined || args.prompt.trim() === '') {
    throw new Error('feature requires a prompt. Usage: orch run feature "what to build"')
  }
  const userPrompt = args.prompt.trim()

  // 0. Hard precondition: codex must be available (two steps depend on it).
  await run(command('require-codex', { argv: ['codex', '--version'], onFailure: 'halt' }))

  // 1. Slug — short kebab-case folder name for this session.
  const slugStep = step.define('slug', {
    agent: claude({ model: HAIKU_MODEL, bare: false }),
    promptFile: 'slug.md',
    returns: schema(SLUG_SCHEMA),
  })
  const { slug } = await run(slugStep, { vars: { userPrompt } })

  // 2. Session directory (+ work/, blockers/, issues/ subfolders).
  const sessionsDir = nodePath.join('docs', 'sessions', slug)
  await mkdir(nodePath.join(sessionsDir, 'work'), { recursive: true })
  await mkdir(nodePath.join(sessionsDir, 'blockers'), { recursive: true })
  await mkdir(nodePath.join(sessionsDir, 'issues'), { recursive: true })

  // 3. Brainstorm — interactive; produces the human-reviewed acceptance contract.
  const brainstormStep = step.define('brainstorm', {
    mode: 'interactive',
    agent: claudeFor(`${slug}-brainstorm`),
    prompt: stepPrompt({
      bodyFile: 'brainstorm.md',
      bodyVars: { userPrompt, sessionsDir },
      sessionsDir,
      artifactName: 'brainstorm.md',
    }),
  })
  await run(brainstormStep)
  await run(commit(`docs(${slug}): brainstorm`))

  // 4. Acceptance tests — interactive.
  const acceptanceStep = step.define('acceptance', {
    mode: 'interactive',
    agent: claudeFor(`${slug}-acceptance`),
    prompt: stepPrompt({
      bodyFile: 'acceptance-tests.md',
      bodyVars: { sessionsDir },
      sessionsDir,
      artifactName: 'acceptance-tests.md',
    }),
  })
  await run(acceptanceStep)
  await run(commit(`docs(${slug}): acceptance tests`))

  // 5. Doc review — interactive; auto-fix minor, discuss scope-changing with user.
  const docReviewStep = step.define('doc-review', {
    mode: 'interactive',
    agent: claudeFor(`${slug}-doc-review`),
    prompt: stepPrompt({
      bodyFile: 'doc-review.md',
      bodyVars: { sessionsDir },
      sessionsDir,
      artifactName: 'doc-review.md',
    }),
  })
  await run(docReviewStep)
  await run(commit(`docs(${slug}): doc review`))

  // 6. Refine loop — ask the user; each "refine" reopens brainstorm + acceptance
  //    (the refine agent asks the user what is wrong, no input is collected here).
  for (let i = 1; i <= MAX_REFINE; i++) {
    const decision = await run(SPEC_OK, { as: `spec-ok-${i}` })
    if (decision.cancelled || decision.button === 'ok') break

    const refineStep = step.define('refine', {
      mode: 'interactive',
      agent: claudeFor(`${slug}-refine-${i}`),
      prompt: stepPrompt({
        bodyFile: 'refine.md',
        bodyVars: { sessionsDir },
        sessionsDir,
        artifactName: `refine-${i}.md`,
      }),
    })
    await run(refineStep, { as: `refine-${i}` })
    await run(commit(`docs(${slug}): refine round ${i}`))
  }

  // 7. Plan — autonomous; split into 1-4 phases with Status + AI-vs-user-input.
  const planStep = step.define('plan', {
    agent: claudeFor(`${slug}-plan`),
    prompt: stepPrompt({
      bodyFile: 'plan.md',
      bodyVars: { sessionsDir },
      sessionsDir,
      artifactName: 'plan.md',
      blockerLabel: 'plan',
    }),
  })
  await run(planStep)
  await run(commit(`docs(${slug}): plan`))
  await handleBlocker(run, sessionsDir, slug, 'plan')

  // 8. Plan review — autonomous codex critique of the plan.
  const planReviewStep = step.define('plan-review', {
    agent: codexAuto(),
    prompt: stepPrompt({
      bodyFile: 'plan-review-codex.md',
      bodyVars: { sessionsDir },
      sessionsDir,
      artifactName: 'plan-review.md',
    }),
  })
  await run(planReviewStep)
  await run(commit(`docs(${slug}): plan review`))

  // 9. Plan apply — autonomous claude folds sensible findings into the plan.
  const planApplyStep = step.define('plan-apply', {
    agent: claudeFor(`${slug}-plan-apply`),
    prompt: stepPrompt({
      bodyFile: 'plan-apply.md',
      bodyVars: { sessionsDir },
      sessionsDir,
      artifactName: 'plan-review-applied.md',
      blockerLabel: 'plan-apply',
    }),
  })
  await run(planApplyStep)
  await run(commit(`docs(${slug}): plan review applied`))
  await handleBlocker(run, sessionsDir, slug, 'plan-apply')

  // 10. Implementation loop.
  await runWorkLoop(run, {
    max: MAX_WORK,
    label: 'work-impl',
    bodyFile: 'work-impl.md',
    artifactPrefix: 'work/impl-phase',
    sessionsDir,
    slug,
  })

  // 11. Dual code review — claude + codex in parallel, each writes its own artifact.
  const ceReviewStep = step.define('code-review-ce', {
    agent: claudeFor(`${slug}-code-review-ce`),
    prompt: stepPrompt({
      bodyFile: 'code-review-ce.md',
      bodyVars: { sessionsDir },
      sessionsDir,
      artifactName: 'code-review-ce.md',
      blockerLabel: 'code-review-ce',
    }),
  })
  const codexReviewStep = step.define('code-review-codex', {
    agent: codexAuto(),
    prompt: stepPrompt({
      bodyFile: 'code-review-codex.md',
      bodyVars: { sessionsDir },
      sessionsDir,
      artifactName: 'code-review-codex.md',
      blockerLabel: 'code-review-codex',
    }),
  })
  await parallel([run(ceReviewStep), run(codexReviewStep)])
  await run(commit(`docs(${slug}): code reviews`))
  await handleBlocker(run, sessionsDir, slug, 'code-review-ce')
  await handleBlocker(run, sessionsDir, slug, 'code-review-codex')

  // 12. Triage — select the middle-way fixes; everything else worth mentioning
  //     becomes its own file under issues/.
  const triageStep = step.define('triage', {
    agent: claudeFor(`${slug}-triage`),
    prompt: stepPrompt({
      bodyFile: 'triage.md',
      bodyVars: { sessionsDir },
      sessionsDir,
      artifactName: 'fix-plan.md',
    }),
  })
  await run(triageStep)
  await run(commit(`docs(${slug}): fix plan`))

  // 13. Fix loop.
  await runWorkLoop(run, {
    max: MAX_FIX_WORK,
    label: 'work-fix',
    bodyFile: 'work-fix.md',
    artifactPrefix: 'work/fix-group',
    sessionsDir,
    slug,
  })

  // 14. Green gate — `bun run check`; on failure hand off to a fix agent, retry.
  for (let i = 1; i <= MAX_CHECK; i++) {
    const result = await run(
      command(`check-${i}`, { argv: ['bun', 'run', 'check'], onFailure: 'continue' }),
    )
    if (result.exitCode === 0) break

    const fixCheckStep = step.define('fix-check', {
      agent: claudeFor(`${slug}-fix-check-${i}`),
      prompt: stepPrompt({
        bodyFile: 'fix-check.md',
        bodyVars: { sessionsDir },
        sessionsDir,
        artifactName: 'check-report.md',
      }),
    })
    await run(fixCheckStep, {
      as: `fix-check-${i}`,
      extraContext: { failing: tail(`${result.stdout}\n${result.stderr}`, 200) },
    })
    await run(commit(`fix(${slug}): lint + tests round ${i}`))
  }
})
