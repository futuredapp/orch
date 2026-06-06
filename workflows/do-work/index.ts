/**
 * do-work — work a plan file to completion in an autonomous loop.
 *
 * Pipeline:
 *   for i in 1..MAX_ITERATIONS:
 *     1. select-work-<i>   autonomous, haiku    → { done, work }
 *     2. if done: break
 *     3. work-<i>          autonomous, claude   → uncommitted changes + summaries entry
 *     4. run-tests-<i>     command: bun run check   onFailure: continue
 *     5. if failed: fix-tests-<i>   autonomous, claude
 *
 * Prompt files (sibling .md):
 *   - select-work.md   ({{planFile}}, {{summariesFile}})
 *   - work.md          ({{work}}, {{planFile}}, {{summariesFile}})
 *   - fix-tests.md     ({{planFile}}, {{testOutput}})
 *
 * No interactive steps — runs under --mode=plain and --noninteractive.
 *
 * Usage:
 *   bunx orch run do-work "docs/sessions/<slug>/plan.md"
 */

import * as nodePath from 'node:path'
import { z } from 'zod'
import { command, schema, step, tail, workflow } from '../../src/core/index.ts'
import { claude } from '../../src/runners/index.ts'
import type { Runner } from '../../src/runners/index.ts'

process.env.IS_SANDBOX = '1'

const HAIKU_MODEL = 'claude-haiku-4-5-20251001'
const MAX_ITERATIONS = 10

const SELECT_SCHEMA = z.object({ done: z.boolean(), work: z.string() })

function claudeFor(sessionName: string): Runner {
  return claude({
    bare: false,
    flags: ['--dangerously-skip-permissions', '--name', sessionName],
  })
}

// Defined at module scope — vars bound at run() time so the same step definition
// is reused across iterations with distinct as: keys.
const SELECT_WORK = step.define('select-work', {
  agent: claude({ model: HAIKU_MODEL, bare: false }),
  promptFile: 'select-work.md',
  returns: schema(SELECT_SCHEMA),
})

const RUN_TESTS = command('run-tests', {
  argv: ['bun', 'run', 'check'],
  onFailure: 'continue',
})

export default workflow('do-work', async (run, args) => {
  const planFile = args.prompt?.trim()
  if (planFile === undefined || planFile === '') {
    throw new Error(
      'do-work requires the path to a plan file. ' +
        'Usage: orch run do-work "docs/sessions/<slug>/plan.md"',
    )
  }
  const summariesFile = nodePath.join(nodePath.dirname(planFile), 'work-summaries.md')

  for (let i = 1; i <= MAX_ITERATIONS; i++) {
    const { done, work } = await run(SELECT_WORK, {
      as: `select-work-${i}`,
      vars: { planFile, summariesFile },
    })

    if (done) break

    // Defined inside the loop so the runner carries a unique --name per iteration
    // (better two-pane session UX). The as: key is what drives memoization.
    const workStep = step.define('work', {
      agent: claudeFor(`do-work-work-${i}`),
      promptFile: 'work.md',
    })
    await run(workStep, {
      as: `work-${i}`,
      vars: { work, planFile, summariesFile },
    })

    const testResult = await run(RUN_TESTS, { as: `run-tests-${i}` })

    if (testResult.exitCode !== 0) {
      const fixStep = step.define('fix-tests', {
        agent: claudeFor(`do-work-fix-${i}`),
        promptFile: 'fix-tests.md',
      })
      await run(fixStep, {
        as: `fix-tests-${i}`,
        vars: {
          planFile,
          testOutput: tail(testResult.stdout + testResult.stderr, 200),
        },
      })
    }
  }
})
