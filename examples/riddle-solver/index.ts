/**
 * riddle-solver — two-step demo of the orch pipeline.
 *
 * Chains two real `claude` CLI invocations through ClaudeRunner:
 *   1. write-riddle  — invent a riddle, write it to riddle_<suffix>.txt
 *   2. solve-riddle  — read that file, write the answer to solution_<suffix>.txt
 *
 * Both steps share the sandbox cwd, so step 2 reads step 1's file directly.
 * The <suffix> is derived from runId so a --run-id resume references the
 * exact same filenames step 1 originally created.
 *
 * Usage:
 *   bun run examples/riddle-solver/index.ts
 *   bun run examples/riddle-solver/index.ts --run-id=r-2026-04-11-abc123
 *
 * Requirements: `claude` must be on PATH.
 */

import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'
import { step, workflow, type WorkflowDeps } from '../../src/core/index.ts'
import { claude } from '../../src/runners/index.ts'
import { BunClock, BunFsService, BunProcessService, path } from '../../src/services/index.ts'
import { FileStateStore, generateRunId, type RunId, runId } from '../../src/state/index.ts'

const here = import.meta.dir
const sandboxDir = nodePath.join(here, 'sandbox')
const stateDir = nodePath.join(here, 'state')

await fs.mkdir(sandboxDir, { recursive: true })
await fs.mkdir(stateDir, { recursive: true })

const RUN_ID_FLAG = '--run-id='
const forcedId = process.argv.find((a) => a.startsWith(RUN_ID_FLAG))?.slice(RUN_ID_FLAG.length)

const clock = new BunClock()
const runIdVal: RunId = forcedId !== undefined ? runId(forcedId) : generateRunId({ clock })

// Suffix derives from runId so resumes hit the same filenames step 1 wrote.
const suffix = runIdVal.replace(/^r-/, '')
const riddleFile = `riddle_${suffix}.txt`
const solutionFile = `solution_${suffix}.txt`

// `bare: false` and `bypassPermissions` mirror hello-file: subscription auth
// works, and Claude can use Read/Write tools without per-call prompts.
const WRITE_RIDDLE = step.define('write-riddle', {
  agent: claude({
    bare: false,
    flags: ['--permission-mode', 'bypassPermissions'],
  }),
  prompt:
    `Invent one short original riddle (2-4 lines, in English) and write it to ./${riddleFile}. ` +
    `Write only the riddle text — no title, no preamble, no answer, no code fences, no trailing newline.`,
})

const SOLVE_RIDDLE = step.define('solve-riddle', {
  agent: claude({
    bare: false,
    flags: ['--permission-mode', 'bypassPermissions'],
  }),
  prompt:
    `Read the riddle in ./${riddleFile}, work out the answer, and write your answer to ./${solutionFile}. ` +
    `Write only the answer (one short line) — no preamble, no explanation, no code fences, no trailing newline.`,
})

const deps: WorkflowDeps = {
  stateStore: new FileStateStore({ fs: new BunFsService(), basePath: path(stateDir) }),
  processService: new BunProcessService(),
  clock,
  runId: runIdVal,
  cwd: path(sandboxDir),
}

const wf = workflow('riddle-solver-demo', async (run) => {
  const riddle = await run(WRITE_RIDDLE)
  console.log('[orch] riddle step returned:', riddle)
  const solution = await run(SOLVE_RIDDLE)
  console.log('[orch] solve  step returned:', solution)
})

console.log(`[orch] runId    = ${runIdVal}`)
console.log(`[orch] sandbox  = ${sandboxDir}`)
console.log(`[orch] state    = ${stateDir}`)
console.log(`[orch] riddle   = ${riddleFile}`)
console.log(`[orch] solution = ${solutionFile}`)

await wf.execute(deps)

console.log(`[orch] done. expect files at:`)
console.log(`  ${nodePath.join(sandboxDir, riddleFile)}`)
console.log(`  ${nodePath.join(sandboxDir, solutionFile)}`)
