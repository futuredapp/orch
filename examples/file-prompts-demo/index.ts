/**
 * file-prompts-demo — file-based prompts in a working pipeline.
 *
 * Demonstrates every surface of the new prompt-file API:
 *
 *   - `promptFile:` with `vars:` (workflow-local sibling .md)
 *   - `loadPrompt()` composition mixing workflow-local and project-rooted (`@/...`) fragments
 *   - the canonical `.orch/prompts/` location for shared fragments
 *
 * Pipeline:
 *   1. slug       autonomous, haiku, returns { slug } — prompt from `slug.md`
 *   2. research   autonomous, claude, writes `<sessionsDir>/findings.md`
 *                 — prompt composed from `research.md` + `@/.orch/prompts/session-context.md`
 *   3. summarize  autonomous, claude, writes `<sessionsDir>/summary.md` — prompt from `summarize.md`
 *
 * Usage (autonomous, no human):
 *   bunx orch run file-prompts-demo "explore a feature idea"
 *
 * The corresponding sibling files live next to this file:
 *   slug.md          (workflow-local, uses {{userPrompt}})
 *   research.md      (workflow-local, uses {{slug}} and {{sessionsDir}})
 *   summarize.md     (workflow-local, uses {{sessionsDir}})
 *   ../.orch/prompts/session-context.md  (project-rooted, uses {{sessionsDir}})
 */

import { mkdir } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { z } from 'zod'
import { loadPrompt, schema, step, workflow } from '../../src/core/index.ts'
import { claude } from '../../src/runners/index.ts'

const HAIKU_MODEL = 'claude-haiku-4-5-20251001'

const SLUG_SCHEMA = z.object({
  slug: z
    .string()
    .min(2)
    .max(30)
    .regex(/^[a-z][a-z0-9-]*[a-z0-9]$/, 'slug must be lowercase kebab-case'),
})

const AUTONOMOUS = claude({
  bare: false,
  flags: ['--permission-mode', 'bypassPermissions'],
})

export default workflow('file-prompts-demo', async (run, args) => {
  if (args.prompt === undefined || args.prompt.trim() === '') {
    throw new Error(
      'file-prompts-demo requires a prompt. Usage: orch run file-prompts-demo "feature idea"',
    )
  }
  const userPrompt = args.prompt.trim()

  // Step 1 — workflow-local promptFile; vars supplied at run() under R23.
  const slugStep = step.define('slug', {
    agent: claude({ model: HAIKU_MODEL, bare: false }),
    promptFile: 'slug.md',
    returns: schema(SLUG_SCHEMA),
  })
  const { slug } = await run(slugStep, { vars: { userPrompt } })

  const sessionsDir = nodePath.join('docs', 'sessions', slug)
  await mkdir(sessionsDir, { recursive: true })

  // Step 2 — composition via loadPrompt. Glue the workflow-local research.md
  // with the project-rooted session-context.md and feed the result via the
  // existing `prompt:` field.
  const researchBody = loadPrompt('research.md', { slug, sessionsDir })
  const sessionContext = loadPrompt('@/.orch/prompts/session-context.md', { sessionsDir })
  const researchStep = step.define('research', {
    agent: AUTONOMOUS,
    prompt: `${researchBody}\n\n${sessionContext}`,
  })
  await run(researchStep)

  // Step 3 — workflow-local promptFile; vars supplied at run() under R23.
  const summarizeStep = step.define('summarize', {
    agent: AUTONOMOUS,
    promptFile: 'summarize.md',
  })
  await run(summarizeStep, { vars: { sessionsDir } })
})
