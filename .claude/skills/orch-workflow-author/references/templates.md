# Workflow templates

Each template is a complete, self-contained file. Steps and the `workflow(...)` body are defined together. Adapt names, prompts, schemas, and iteration counts — keep the structure.

All templates assume the file lives under `workflows/<name>/index.ts` (this repo's current layout). Adjust the `../../src/core` / `../../src/runners` relative paths if you place the file elsewhere.

---

## Template A — Linear pipeline (3 autonomous steps)

The simplest useful shape. Each step reads what the previous step produced.

```ts
/**
 * feature-spec — one-shot: brainstorm → plan → review, all autonomous, in a fresh sessions folder.
 *
 * Usage:
 *   bunx orch run feature-spec "describe what you want to build"
 */

import { mkdir } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { z } from 'zod'
import { schema, step, workflow } from '../../src/core/index.ts'
import { claude } from '../../src/runners/index.ts'

process.env.IS_SANDBOX = '1'

const HAIKU = 'claude-haiku-4-5-20251001'

// Structural only — the kebab-case rule lives in the prompt below, not here.
const SLUG_SCHEMA = z.object({ slug: z.string() })

const AUTONOMOUS = claude({
  bare: false,
  flags: ['--permission-mode', 'bypassPermissions'],
})

export default workflow('feature-spec', async (run, args) => {
  if (args.prompt === undefined || args.prompt.trim() === '') {
    throw new Error('feature-spec requires a prompt. Usage: orch run feature-spec "<idea>"')
  }
  const userPrompt = args.prompt.trim()

  const SLUG = step.define('slug', {
    agent: claude({ model: HAIKU, bare: false }),
    prompt:
      'Return a 2-4 word kebab-case slug for this idea (lowercase a-z, digits, hyphens; ' +
      `no leading digit, no trailing hyphen).\n\nIdea:\n${userPrompt}`,
    returns: schema(SLUG_SCHEMA),
  })
  const { slug } = await run(SLUG)

  const sessionsDir = nodePath.join('docs', 'sessions', slug)
  await mkdir(sessionsDir, { recursive: true })

  const BRAINSTORM = step.define('brainstorm', {
    agent: AUTONOMOUS,
    prompt:
      `Brainstorm "${userPrompt}". Write \`${sessionsDir}/brainstorm.md\` with 5-10 bullets ` +
      `covering goals, constraints, and 1-2 open questions. Stop after writing the file.`,
  })
  await run(BRAINSTORM)

  const PLAN = step.define('plan', {
    agent: AUTONOMOUS,
    prompt:
      `Read \`${sessionsDir}/brainstorm.md\` and produce \`${sessionsDir}/plan.md\` — ` +
      `a numbered, phased plan (3-7 phases, one paragraph each). Stop after writing.`,
  })
  await run(PLAN)

  const REVIEW = step.define('review', {
    agent: AUTONOMOUS,
    prompt:
      `Read both \`${sessionsDir}/brainstorm.md\` and \`${sessionsDir}/plan.md\` and write ` +
      `\`${sessionsDir}/review.md\` — a 3-6 bullet critique calling out gaps, risks, and one ` +
      `concrete next step. Stop after writing.`,
  })
  await run(REVIEW)
})
```

---

## Template B — Loop-until-done with a haiku judge

Cap iterations, use a cheap model as the "is it done?" oracle, break on `done: true`.

```ts
/**
 * implement-phase-1 — drive phase 1 of an existing plan to completion in up to 5 passes.
 *
 * Usage:
 *   bunx orch run implement-phase-1 "/path/to/docs/sessions/<slug>"
 */

import { z } from 'zod'
import { schema, step, workflow } from '../../src/core/index.ts'
import { claude } from '../../src/runners/index.ts'

process.env.IS_SANDBOX = '1'

const HAIKU = 'claude-haiku-4-5-20251001'
const MAX_ITERATIONS = 5

const PHASE_DONE_SCHEMA = z.object({
  done: z.boolean(),
  reason: z.string(),
})

const AUTONOMOUS = claude({
  bare: false,
  flags: ['--dangerously-skip-permissions'],
})

export default workflow('implement-phase-1', async (run, args) => {
  const sessionsDir = args.prompt?.trim()
  if (sessionsDir === undefined || sessionsDir === '') {
    throw new Error('Pass the session directory path as the prompt arg.')
  }

  for (let i = 1; i <= MAX_ITERATIONS; i++) {
    const WORK = step.define(`work-${i}`, {
      agent: AUTONOMOUS,
      prompt:
        `Implement PHASE 1 of the plan at \`${sessionsDir}/plan.md\`. ` +
        `Read \`${sessionsDir}/plan.md\` first. ` +
        `Hard constraints: (1) stay on the current git branch; (2) do NOT run git commit / git push; ` +
        `(3) if phase 1 looks complete in the working tree, do nothing and say so. ` +
        `If a previous iteration started phase 1, continue from there.`,
    })
    await run(WORK)

    const CHECK = step.define(`check-${i}`, {
      agent: claude({ model: HAIKU, bare: false }),
      prompt:
        `Decide whether PHASE 1 of the plan is fully implemented. ` +
        `Read \`${sessionsDir}/plan.md\` to see what phase 1 requires, then inspect the working ` +
        `tree (\`git status\`, \`git diff\`) to judge. Return JSON: { "done": boolean, "reason": string }.`,
      returns: schema(PHASE_DONE_SCHEMA),
    })
    const { done, reason } = await run(CHECK)
    if (done) {
      console.log(`[implement-phase-1] done at iteration ${i}: ${reason}`)
      break
    }
  }
})
```

---

## Template C — Parallel multi-lens review then synthesize

```ts
/**
 * triage — three lenses in parallel (security / performance / design), then synthesize.
 *
 * Usage:
 *   bunx orch run triage "path/to/file/or/PR/description"
 */

import { z } from 'zod'
import { parallel, schema, step, workflow } from '../../src/core/index.ts'
import { claude } from '../../src/runners/index.ts'

const LENSES = ['security', 'performance', 'design'] as const

// Structural only: the "at most ~20 issues" cap is expressed in the prompt.
const REVIEW_SCHEMA = z.object({
  lens: z.string(),
  passed: z.boolean(),
  issues: z.array(z.string()),
})

const AUTONOMOUS = claude({ bare: false, flags: ['--permission-mode', 'bypassPermissions'] })

const REVIEW = step.define('review', {
  agent: AUTONOMOUS,
  prompt: '<filled in per branch via overrides>',
  returns: schema(REVIEW_SCHEMA),
})

const SYNTHESIZE = step.define('synthesize', {
  agent: AUTONOMOUS,
  prompt: '<filled in via extraContext>',
})

export default workflow('triage', async (run, args) => {
  const target = args.prompt?.trim()
  if (target === undefined || target === '') {
    throw new Error('triage requires a target (file path or PR description).')
  }

  const reviews = await parallel(
    LENSES,
    (lens) =>
      run(REVIEW, {
        as: `review-${lens}`,
        prompt:
          `Review "${target}" through the ${lens} lens only. Read the target first. ` +
          `Return JSON { "lens": "${lens}", "passed": boolean, "issues": string[] }. ` +
          `Cap issues at 20. Stop after returning the JSON.`,
      }),
    { concurrency: 3 },
  )

  const failing = reviews.filter((r) => !r.passed)
  if (failing.length === 0) {
    console.log('[triage] all three lenses passed.')
    return
  }

  await run(SYNTHESIZE, {
    prompt:
      `Synthesize the failing reviews below into a single prioritized action list ` +
      `(highest impact first). Write the list to \`triage-summary.md\`. Stop after writing.`,
    extraContext: { failing },
  })
})
```

---

## Template D — Brainstorm (interactive) → plan → work → review

The full compound-engineering shape. Most workflows in this repo are a variant of this. Requires `--mode=two-pane` because the brainstorm step is interactive.

```ts
/**
 * compound-feature — interactive brainstorm followed by autonomous plan/work/review.
 *
 * Usage:
 *   bunx orch run compound-feature --mode=two-pane "what to build"
 */

import { mkdir } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { z } from 'zod'
import { schema, step, workflow } from '../../src/core/index.ts'
import { claude } from '../../src/runners/index.ts'
import type { Runner } from '../../src/runners/index.ts'

process.env.IS_SANDBOX = '1'

const HAIKU = 'claude-haiku-4-5-20251001'
const MAX_WORK_ITERATIONS = 5

const SLUG_SCHEMA = z.object({ slug: z.string() })
const PHASE_DONE_SCHEMA = z.object({
  done: z.boolean(),
  reason: z.string(),
})

function claudeFor(sessionName: string): Runner {
  return claude({
    bare: false,
    flags: ['--dangerously-skip-permissions', '--name', sessionName],
  })
}

export default workflow('compound-feature', async (run, args) => {
  const userPrompt = args.prompt?.trim()
  if (userPrompt === undefined || userPrompt === '') {
    throw new Error('compound-feature requires a prompt.')
  }

  const SLUG = step.define('slug', {
    agent: claude({ model: HAIKU, bare: false }),
    prompt: `Return a 2-4 word kebab-case slug for: ${userPrompt}`,
    returns: schema(SLUG_SCHEMA),
  })
  const { slug } = await run(SLUG)
  const sessionsDir = nodePath.join('docs', 'sessions', slug)
  await mkdir(sessionsDir, { recursive: true })

  const sessionContext =
    `\n\nSession management: store every artefact under \`${sessionsDir}/\` ` +
    `using stable filenames (\`brainstorm.md\`, \`plan.md\`, \`review.md\`).`

  const BRAINSTORM = step.define('brainstorm', {
    mode: 'interactive',
    agent: claudeFor(`${slug}-brainstorm`),
    prompt: `/workflows:brainstorm ${userPrompt}${sessionContext}`,
  })
  await run(BRAINSTORM)

  const PLAN = step.define('plan', {
    agent: claudeFor(`${slug}-plan`),
    prompt:
      `/compound-engineering:workflows:plan ` +
      `Analyse the brainstorm written under \`${sessionsDir}/\` and produce \`${sessionsDir}/plan.md\` ` +
      `with a phased implementation plan. Read every file in that directory first.${sessionContext}`,
  })
  await run(PLAN)

  for (let i = 1; i <= MAX_WORK_ITERATIONS; i++) {
    const WORK = step.define(`work-${i}`, {
      agent: claudeFor(`${slug}-work-${i}`),
      prompt:
        `/compound-engineering:workflows:work ` +
        `Implement PHASE 1 of \`${sessionsDir}/plan.md\`. Hard constraints: stay on this branch, ` +
        `do NOT commit or push. If phase 1 already looks complete in the working tree, ` +
        `say so and stop.${sessionContext}`,
    })
    await run(WORK)

    const CHECK = step.define(`check-${i}`, {
      agent: claude({ model: HAIKU, bare: false }),
      prompt:
        `Decide whether PHASE 1 of \`${sessionsDir}/plan.md\` is fully implemented. ` +
        `Inspect the working tree. Return { "done": boolean, "reason": string }.`,
      returns: schema(PHASE_DONE_SCHEMA),
    })
    const { done } = await run(CHECK)
    if (done) break
  }

  const REVIEW = step.define('review', {
    agent: claudeFor(`${slug}-review`),
    prompt:
      `/compound-engineering:workflows:review ` +
      `Review the phase-1 work in the working tree (uncommitted changes). Cross-reference ` +
      `against \`${sessionsDir}/plan.md\` and \`${sessionsDir}/brainstorm.md\`. ` +
      `Write \`${sessionsDir}/review.md\` and stop.${sessionContext}`,
  })
  await run(REVIEW)
})
```

---

## Template E — With `ask()` checkpoint inside a loop

For workflows where the human should approve / redirect each iteration.

```ts
/**
 * iterate-with-feedback — autonomous work + ask() checkpoint between iterations.
 *
 * Usage:
 *   bunx orch run iterate-with-feedback "describe the work"
 *   bunx orch run iterate-with-feedback --noninteractive "<…>"   # uses defaults
 */

import { ask, step, workflow } from '../../src/core/index.ts'
import { claude } from '../../src/runners/index.ts'

const MAX_ITERATIONS = 5

const AUTONOMOUS = claude({ bare: false, flags: ['--permission-mode', 'bypassPermissions'] })

const WORK = step.define('work', {
  agent: AUTONOMOUS,
  prompt: '<filled in per iteration>',
})

const CHECKPOINT = ask({
  name: 'continue',
  question: 'Continue iterating? (retry re-runs with your notes; abort exits)',
  fields: { notes: { placeholder: 'extra direction for the next pass (optional)' } },
  buttons: ['continue', 'retry', 'abort'],
  defaultWhenNoninteractive: { button: 'continue' },
})

export default workflow('iterate-with-feedback', async (run, args) => {
  const userPrompt = args.prompt?.trim() ?? 'do the next obvious thing'

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    await run(WORK, {
      as: `work-${i}`,
      prompt:
        `Iteration ${i + 1}. Goal: ${userPrompt}. ` +
        `Make focused progress; do not commit; stop when there's a coherent unit of work to review.`,
    })

    const decision = await run(CHECKPOINT, { as: `checkpoint-${i}` })
    if (decision.cancelled || decision.button === 'abort') break
    if (decision.button === 'retry') {
      const notes = (decision as unknown as { fields: { notes: string } }).fields.notes
      await run(WORK, {
        as: `retry-${i}`,
        prompt: `Redo the last iteration with this extra direction: ${notes}`,
      })
    }
  }
})
```

---

## Template F — File-based prompts (default for non-trivial prompts)

Same shape as Template A, but every prompt longer than ~3 sentences lives in a sibling `.md` file. This is the recommended layout for any workflow with substantive prompt prose. The corresponding worked example in this repo is [`examples/file-prompts-demo/`](../../../examples/file-prompts-demo/).

```ts
/**
 * file-spec — linear pipeline, prompts in sibling .md files.
 *
 * Prompt files (sibling to this index.ts):
 *   - slug.md        ({{userPrompt}})
 *   - research.md    ({{slug}}, {{sessionsDir}})
 *   - summarize.md   ({{sessionsDir}})
 * Shared (under .orch/prompts/ at project root):
 *   - @/.orch/prompts/session-context.md   ({{sessionsDir}})
 *
 * Usage:
 *   bunx orch run file-spec "<idea>"
 */

import { mkdir } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { z } from 'zod'
import { loadPrompt, schema, step, workflow } from '../../src/core/index.ts'
import { claude } from '../../src/runners/index.ts'

const HAIKU = 'claude-haiku-4-5-20251001'

const SLUG_SCHEMA = z.object({ slug: z.string() })

const AUTONOMOUS = claude({
  bare: false,
  flags: ['--permission-mode', 'bypassPermissions'],
})

export default workflow('file-spec', async (run, args) => {
  if (args.prompt === undefined || args.prompt.trim() === '') {
    throw new Error('file-spec requires a prompt. Usage: orch run file-spec "<idea>"')
  }
  const userPrompt = args.prompt.trim()

  // promptFile — workflow-local sibling file. Vars live on `run()`.
  const SLUG = step.define('slug', {
    agent: claude({ model: HAIKU, bare: false }),
    promptFile: 'slug.md',
    returns: schema(SLUG_SCHEMA),
  })
  const { slug } = await run(SLUG, { vars: { userPrompt } })

  const sessionsDir = nodePath.join('docs', 'sessions', slug)
  await mkdir(sessionsDir, { recursive: true })

  // loadPrompt composition — glue a workflow-local fragment with a shared
  // fragment from the project-rooted .orch/prompts/ folder, then feed via
  // the existing `prompt:` field.
  const researchBody = loadPrompt('research.md', { slug, sessionsDir })
  const sessionCtx   = loadPrompt('@/.orch/prompts/session-context.md', { sessionsDir })
  const RESEARCH = step.define('research', {
    agent: AUTONOMOUS,
    prompt: `${researchBody}\n\n${sessionCtx}`,
  })
  await run(RESEARCH)

  // promptFile again — vars supplied per-call.
  const SUMMARIZE = step.define('summarize', {
    agent: AUTONOMOUS,
    promptFile: 'summarize.md',
  })
  await run(SUMMARIZE, { vars: { sessionsDir } })
})
```

The matching `.md` files (sibling to `index.ts`) look like:

```md
<!-- slug.md -->
Return a 2-4 word kebab-case slug for the idea below. Lowercase a-z, digits, and hyphens only.

Idea:

{{userPrompt}}
```

```md
<!-- research.md -->
Research the feature idea slugged "{{slug}}" and write `{{sessionsDir}}/findings.md`.
Skim the working directory to identify 3–6 concrete points relevant to the feature, then
write one short paragraph per point. Write only the file.
```

```md
<!-- summarize.md -->
Read `{{sessionsDir}}/findings.md` and write `{{sessionsDir}}/summary.md` — 3–6 short
bullets and a one-sentence closing about the most important next step. Write only the file.
```

```md
<!-- @/.orch/prompts/session-context.md -->
Session management:

Every artefact this workflow produces lives under `{{sessionsDir}}/`. The directory already
exists. Use stable filenames so later steps can find them. Do not commit, push, or switch branches.
```

---

## How to pick a template

| Shape you described | Start from |
|---|---|
| Read input → write one or two markdown files | A |
| Drive an existing plan to completion | B |
| Compare multiple options or run multiple reviews | C |
| Full compound-engineering flow with an interactive turn | D |
| Iterative work with a human checkpoint between passes | E |
| Anything where prompts are long enough to live in `.md` files (most non-trivial workflows) | F |

When in doubt, start from A and add complexity only when the user's workflow shape actually demands it. A 60-line linear workflow beats a 300-line "framework." For prompt prose longer than ~3 sentences per step, prefer F — file-based prompts make the workflow shape readable without scrolling past walls of backticked text.
