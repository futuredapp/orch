/**
 * codex-riddle-solver — two-step demo of the orch pipeline using CodexRunner.
 *
 * Mirrors examples/riddle-solver but swaps Claude for Codex:
 *   1. write-riddle  — invent a riddle, write it to riddle_<suffix>.txt
 *   2. solve-riddle  — read that file, write the answer to solution_<suffix>.txt
 *
 * Both steps share the sandbox cwd so step 2 reads step 1's file directly.
 * The <suffix> is derived from runId so a --run-id resume references the same
 * filenames step 1 originally created.
 *
 * Note on "interactive" mode:
 *   The Codex runner declares `supports.interactive = false`, so a step with
 *   `mode: 'interactive'` would throw RunnerCapabilityError. Both steps below
 *   are autonomous (Codex's only supported step mode in orch today).
 *
 *   You CAN still flex the workflow-level interactivity axis with the
 *   --noninteractive flag — that controls how ask() steps resolve. This demo
 *   has no ask() steps, so the flag is mostly a smoke test for wiring.
 *
 * Usage:
 *   bun run examples/codex-riddle-solver/index.ts
 *   bun run examples/codex-riddle-solver/index.ts --run-id=r-2026-05-01-abc123
 *   bun run examples/codex-riddle-solver/index.ts --prompt="about the ocean"
 *   bun run examples/codex-riddle-solver/index.ts --noninteractive
 *
 * Requirements: `codex` (>= 0.118.0) must be on PATH.
 */

import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'
import { step, workflow, type WorkflowDeps } from '../../src/core/index.ts'
import { createPlainHost } from '../../src/hosts/index.ts'
import { codex } from '../../src/runners/index.ts'
import {
  BunClock,
  BunFsService,
  BunGitService,
  BunProcessService,
  path,
} from '../../src/services/index.ts'
import { FileStateStore, generateRunId, type RunId, runId } from '../../src/state/index.ts'
import { check, fileProduced } from '../../src/validators/index.ts'
import { ReadlinePromptService } from '../../src/services/prompt/index.ts'

const here = import.meta.dir
const sandboxDir = nodePath.join(here, 'sandbox')
const stateDir = nodePath.join(here, 'state')

await fs.mkdir(sandboxDir, { recursive: true })
await fs.mkdir(stateDir, { recursive: true })

const RUN_ID_FLAG = '--run-id='
const forcedId = process.argv.find((a) => a.startsWith(RUN_ID_FLAG))?.slice(RUN_ID_FLAG.length)

const PROMPT_FLAG = '--prompt='
const promptSeed = process.argv
  .find((a) => a.startsWith(PROMPT_FLAG))
  ?.slice(PROMPT_FLAG.length)

const noninteractive = process.argv.includes('--noninteractive')

const clock = new BunClock()
const runIdVal: RunId = forcedId !== undefined ? runId(forcedId) : generateRunId({ clock })

// Suffix derives from runId so resumes hit the same filenames step 1 wrote.
const suffix = runIdVal.replace(/^r-/, '')
const riddleFile = `riddle_${suffix}.txt`
const solutionFile = `solution_${suffix}.txt`

const bunFs = new BunFsService()
const processService = new BunProcessService()

// Codex factory takes deps explicitly (fs for schema temp files, ps for
// version preflight). `sandbox: 'workspace-write'` lets Codex write into the
// sandbox cwd without prompting.
const codexAgent = codex(
  { sandbox: 'workspace-write' },
  { fs: bunFs, ps: processService },
)

const themeClause = promptSeed ? ` The riddle should be about: ${promptSeed}.` : ''

const WRITE_RIDDLE = step.define('write-riddle', {
  agent: codexAgent,
  prompt:
    `Invent one short original riddle (2-4 lines, in English) and write it to ./${riddleFile}.${themeClause} ` +
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
  agent: codexAgent,
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

const deps: WorkflowDeps = {
  stateStore: new FileStateStore({ fs: bunFs, basePath: path(stateDir) }),
  processService,
  clock,
  runId: runIdVal,
  cwd: path(sandboxDir),
  fsService: bunFs,
  gitService: new BunGitService({ processService }),
  host: createPlainHost({
    stdout: process.stdout,
    stderr: process.stderr,
    format: 'text',
    clock,
    runId: runIdVal,
    processService,
  }),
  promptService: new ReadlinePromptService(),
  interactivity: noninteractive ? 'noninteractive' : 'interactive',
  ...(promptSeed !== undefined ? { args: { prompt: promptSeed } } : {}),
}

const wf = workflow('codex-riddle-solver-demo', async (run, args) => {
  if (args.prompt !== undefined) console.log('[orch] theme prompt:', args.prompt)
  const riddle = await run(WRITE_RIDDLE)
  console.log('[orch] riddle step returned:', riddle)
  const solution = await run(SOLVE_RIDDLE)
  console.log('[orch] solve  step returned:', solution)
})

console.log(`[orch] runId         = ${runIdVal}`)
console.log(`[orch] sandbox       = ${sandboxDir}`)
console.log(`[orch] state         = ${stateDir}`)
console.log(`[orch] interactivity = ${deps.interactivity}`)
console.log(`[orch] riddle        = ${riddleFile}`)
console.log(`[orch] solution      = ${solutionFile}`)

await wf.execute(deps)

console.log(`[orch] done. expect files at:`)
console.log(`  ${nodePath.join(sandboxDir, riddleFile)}`)
console.log(`  ${nodePath.join(sandboxDir, solutionFile)}`)
