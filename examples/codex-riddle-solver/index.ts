/**
 * codex-riddle-solver — two-step demo of the orch pipeline using CodexRunner.
 *
 * CLI-loadable variant: exports the workflow as `default` so `orch run` drives
 * it with the auto-detected host (two-pane when TTY + tmux ≥ 3.2 are available).
 *
 *   1. write-riddle  — invent a riddle, write it to ./riddle.txt
 *      (interactive: foreground TTY spawn; user can interact with Codex's
 *      Ratatui TUI before it exits)
 *   2. solve-riddle  — read that file, write the answer to ./solution.txt
 *      (autonomous: NDJSON streamed to the transcript pane)
 *
 * Both steps share the workflow cwd so step 2 reads step 1's file directly.
 *
 * Usage:
 *   bunx orch run codex-riddle-solver
 *   bunx orch run codex-riddle-solver "about the ocean"   # → args.prompt
 *   bunx orch run codex-riddle-solver --noninteractive    # workflow-level axis
 *   bunx orch resume <runId>                              # cached → no respawn
 *
 * Requires `codex` (>= 0.118.0) on PATH and a TTY for step 1.
 */

import * as nodePath from 'node:path'
import { step, workflow } from '../../src/core/index.ts'
import { codex } from '../../src/runners/index.ts'
import { BunFsService, BunProcessService, path } from '../../src/services/index.ts'
import { check, fileProduced } from '../../src/validators/index.ts'

const bunFs = new BunFsService()
const processService = new BunProcessService()

const RIDDLE_FILE = 'riddle.txt'
const SOLUTION_FILE = 'solution.txt'

// `sandbox: 'workspace-write'` lets Codex write into the workflow cwd without
// prompting. The runner factory takes its own deps (fs for schema temp files,
// ps for the version preflight).
const codexAgent = codex(
  { sandbox: 'workspace-write' },
  { fs: bunFs, ps: processService },
)

const WRITE_RIDDLE = step.define('write-riddle', {
  agent: codexAgent,
  mode: 'interactive',
  prompt:
    `Invent one short original riddle (2-4 lines, in English) and write it to ./${RIDDLE_FILE}. ` +
    'Write only the riddle text — no title, no preamble, no answer, no code fences, no trailing newline.',
  validate: [
    fileProduced(RIDDLE_FILE),
    check(async (ctx) => {
      const content = await bunFs.readFile(path(nodePath.join(ctx.cwd, RIDDLE_FILE)))
      const trimmed = content.trim()
      if (trimmed.length === 0) return `${RIDDLE_FILE} is empty`
      const lineCount = trimmed.split('\n').length
      if (lineCount > 8) return `${RIDDLE_FILE} has ${lineCount} lines — expected a short riddle`
      return true
    }),
  ],
})

const SOLVE_RIDDLE = step.define('solve-riddle', {
  agent: codexAgent,
  prompt:
    `Read the riddle in ./${RIDDLE_FILE}, work out the answer, and write your answer to ./${SOLUTION_FILE}. ` +
    'Write only the answer (one short line) — no preamble, no explanation, no code fences, no trailing newline.',
  validate: [
    fileProduced(SOLUTION_FILE),
    check(async (ctx) => {
      const content = await bunFs.readFile(path(nodePath.join(ctx.cwd, SOLUTION_FILE)))
      const trimmed = content.trim()
      if (trimmed.length === 0) return `${SOLUTION_FILE} is empty`
      if (trimmed.split('\n').length > 1) return `${SOLUTION_FILE} should be a single line`
      return true
    }),
  ],
})

const wf = workflow('codex-riddle-solver', async (run, args) => {
  if (args.prompt !== undefined) console.log('[orch] theme prompt:', args.prompt)
  const riddle = await run(WRITE_RIDDLE)
  console.log('[orch] riddle step returned:', riddle)
  const solution = await run(SOLVE_RIDDLE)
  console.log('[orch] solve  step returned:', solution)
})

export default wf
