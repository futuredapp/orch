/**
 * feature-loop — the loop-with-feedback pattern that motivated the ask() step.
 *
 * Each iteration runs four autonomous Claude steps that incrementally build a
 * feature spec under `<sandbox>/feature/`:
 *
 *   1. brainstorm-${i}  → writes/updates `feature/brainstorm.md`
 *   2. plan-${i}        → writes/updates `feature/plan.md`
 *   3. work-${i}        → writes/updates `feature/work-notes.md`
 *   4. review-${i}      → writes/updates `feature/review.md`
 *
 * Then ask-${i} pauses the workflow and renders a prompt:
 *
 *   "Continue this iteration?"
 *   notes: <optional extra instructions for the next loop>
 *   [ continue ] [ retry ] [ abort ]
 *
 *   - continue → fall through to next iteration (i++, back to brainstorm)
 *   - retry    → re-run WORK with the typed notes as extraPrompt, then ask again
 *   - abort    → break out of the loop cleanly
 *   - Esc/Ctrl-C → cancelled: true, also breaks
 *
 * This is the smallest realistic shape that exercises every ask() corner:
 * `as:`-scoped iteration keys, retries with extraPrompt, cancellation,
 * and the noninteractive default. For autonomous runs, every ask resolves to
 * `{ cancelled: false, button: 'continue', notes: '' }` from the declared
 * default and the loop runs end-to-end without a human:
 *
 *   bunx orch run feature-loop "describe the feature in one sentence" --noninteractive
 *
 * Usage (interactive, plain mode):
 *   bunx orch run feature-loop "add a CSV exporter to the report module"
 *
 * Usage (interactive, two-pane mode, Ink renderer):
 *   bunx orch run feature-loop --mode=two-pane "add a CSV exporter"
 *
 * Usage (autonomous, no human):
 *   bunx orch run feature-loop --noninteractive "add a CSV exporter"
 *
 * Requirements: `claude` must be on PATH for the four agent steps; the ask
 * step itself has no external dep.
 */

import { ask, claude, step, workflow } from 'orch'

const MAX_ITERATIONS = 5
const FEATURE_DIR = 'feature'

/**
 * Reusable claude config for autonomous steps. `bare: false` so subscription
 * auth + plugins/skills load; `bypassPermissions` so the file-write tools
 * don't prompt per call.
 */
const AUTONOMOUS = claude({
  bare: false,
  flags: ['--permission-mode', 'bypassPermissions'],
})

const BRAINSTORM = step.define('brainstorm', {
  agent: AUTONOMOUS,
  prompt:
    `Brainstorm the feature described in the user prompt below. ` +
    `If \`./${FEATURE_DIR}/brainstorm.md\` already exists, read it and revise; otherwise create it. ` +
    `Keep it short — 5-10 bullets covering goals, constraints, and one or two open questions. ` +
    `Create the \`./${FEATURE_DIR}/\` directory if it does not exist. ` +
    `Write only the file; do not print the brainstorm in your reply.`,
})

const PLAN = step.define('plan', {
  agent: AUTONOMOUS,
  prompt:
    `Read \`./${FEATURE_DIR}/brainstorm.md\` and produce \`./${FEATURE_DIR}/plan.md\` — ` +
    `a numbered, phased implementation plan (3-7 phases), each phase one paragraph. ` +
    `If the plan already exists, revise it against the latest brainstorm. ` +
    `Write only the file.`,
})

const WORK = step.define('work', {
  agent: AUTONOMOUS,
  prompt:
    `Read \`./${FEATURE_DIR}/plan.md\` and produce \`./${FEATURE_DIR}/work-notes.md\` — ` +
    `a draft of the actual work for phase 1 (or the next un-done phase). Include the ` +
    `code/diff/text you would write, plus any caveats. If work-notes.md already exists, ` +
    `extend it rather than overwriting. Write only the file.`,
})

const REVIEW = step.define('review', {
  agent: AUTONOMOUS,
  prompt:
    `Review \`./${FEATURE_DIR}/work-notes.md\` against \`./${FEATURE_DIR}/plan.md\` and write ` +
    `\`./${FEATURE_DIR}/review.md\` — a short critique (3-6 bullets) calling out gaps, ` +
    `risks, and one concrete next step. Write only the file.`,
})

/**
 * The star of the workflow. Discriminated union return:
 *   { cancelled: true,  fields: { notes?: string } }
 *   { cancelled: false, button: 'continue' | 'retry' | 'abort', notes: string }
 *
 * `defaultWhenNoninteractive` lets `--noninteractive` runs proceed without a
 * human. Missing field values zero-fill — `notes` ends up `''`.
 */
const ASK_CONTINUE = ask({
  name: 'continue',
  question: 'Continue this iteration? (retry re-runs work with your notes; abort exits)',
  fields: { notes: { placeholder: 'extra instructions for next loop (optional)' } },
  buttons: ['continue', 'retry', 'abort'],
  defaultWhenNoninteractive: { button: 'continue' },
})

export default workflow('feature-loop', async (run, args) => {
  if (args.prompt === undefined || args.prompt.trim() === '') {
    throw new Error(
      'feature-loop requires a prompt. Usage: orch run feature-loop "describe the feature"',
    )
  }
  const featurePrompt = `Feature request:\n${args.prompt}`

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    await run(BRAINSTORM, { as: `brainstorm-${i}`, extraPrompt: featurePrompt })
    await run(PLAN, { as: `plan-${i}` })
    await run(WORK, { as: `work-${i}` })
    await run(REVIEW, { as: `review-${i}` })

    const answer = await run(ASK_CONTINUE, { as: `ask-${i}` })

    if (answer.cancelled) {
      console.log(`[orch] feature-loop: cancelled at iteration ${i}; exiting.`)
      break
    }

    if (answer.button === 'abort') {
      console.log(`[orch] feature-loop: aborted at iteration ${i}.`)
      break
    }

    if (answer.button === 'retry') {
      const extra = answer.notes.trim()
      const overrides =
        extra.length > 0 ? { as: `retry-${i}`, extraPrompt: extra } : { as: `retry-${i}` }
      await run(WORK, overrides)
      // Fall through — next iteration starts with a fresh brainstorm pass.
    }
    // 'continue' falls through to the next iteration.
  }
})
