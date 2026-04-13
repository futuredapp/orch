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
import {
  BunClock,
  BunFsService,
  BunGitService,
  BunProcessService,
  path,
} from '../../src/services/index.ts'
import { FileStateStore, generateRunId, type RunId, runId } from '../../src/state/index.ts'
import { check, fileProduced } from '../../src/validators/index.ts'

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
const bunFs = new BunFsService()

const WRITE_RIDDLE = step.define('write-riddle', {
  agent: claude({
    bare: false,
    flags: ['--permission-mode', 'bypassPermissions'],
  }),
  prompt:
    `Invent one short original riddle (2-4 lines, in English) and write it to ./${riddleFile}. ` +
    `Write only the riddle text — no title, no preamble, no answer, no code fences, no trailing newline.`,
  validate: [
    fileProduced(riddleFile),
    check(async (ctx) => {
      const content = await bunFs.readFile(path(nodePath.join(ctx.cwd, riddleFile)))
      const trimmed = content.trim()
      if (trimmed.length === 0) return `${riddleFile} is empty`
      const lineCount = trimmed.split('\n').length
      if (lineCount > 8) return `${riddleFile} has ${lineCount} lines — expected a short riddle`
      return true
    }),
  ],
})

const SOLVE_RIDDLE = step.define('solve-riddle', {
  agent: claude({
    bare: false,
    flags: ['--permission-mode', 'bypassPermissions'],
  }),
  prompt:
    `Read the riddle in ./${riddleFile}, work out the answer, and write your answer to ./${solutionFile}. ` +
    `Write only the answer (one short line) — no preamble, no explanation, no code fences, no trailing newline.`,
  validate: [
    fileProduced(solutionFile),
    check(async (ctx) => {
      const content = await bunFs.readFile(path(nodePath.join(ctx.cwd, solutionFile)))
      const trimmed = content.trim()
      if (trimmed.length === 0) return `${solutionFile} is empty`
      if (trimmed.split('\n').length > 1) return `${solutionFile} should be a single line`
      return true
    }),
  ],
})

const processService = new BunProcessService()
const deps: WorkflowDeps = {
  stateStore: new FileStateStore({ fs: bunFs, basePath: path(stateDir) }),
  processService,
  clock,
  runId: runIdVal,
  cwd: path(sandboxDir),
  fsService: bunFs,
  gitService: new BunGitService({ processService }),
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
