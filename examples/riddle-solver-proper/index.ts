/**
 * riddle-solver-proper — CLI-loadable variant of riddle-solver.
 *
 * Unlike `riddle-solver/index.ts`, this module:
 *   - exports the workflow executor as `default` so `orch run` can find it,
 *   - does NOT call `wf.execute(deps)` at import time, and
 *   - uses only autonomous steps, so it composes cleanly with `--tmux`.
 *
 * Usage:
 *   bunx orch run riddle-solver-proper --tmux
 *   bunx orch run riddle-solver-proper --observe
 *   bunx orch run riddle-solver-proper "about the moon"
 *
 * Requirements: `claude` must be on PATH.
 */

import * as nodePath from 'node:path'
import { step, workflow } from '../../src/core/index.ts'
import { claude } from '../../src/runners/index.ts'
import { BunFsService, path } from '../../src/services/index.ts'
import { check, fileProduced } from '../../src/validators/index.ts'

const bunFs = new BunFsService()

const RIDDLE_FILE = 'riddle.txt'
const SOLUTION_FILE = 'solution.txt'

const WRITE_RIDDLE = step.define('write-riddle', {
  agent: claude({
    bare: false,
    flags: ['--permission-mode', 'bypassPermissions'],
  }),
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
  agent: claude({
    bare: false,
    flags: ['--permission-mode', 'bypassPermissions'],
  }),
  prompt:
    `Read the riddle in ./${RIDDLE_FILE}, work out the answer, and write it to ./${SOLUTION_FILE}. ` +
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

const wf = workflow('riddle-solver-proper', async (run, args) => {
  if (args.prompt !== undefined) console.log('[orch] theme prompt:', args.prompt)
  const riddle = await run(WRITE_RIDDLE)
  console.log('[orch] riddle step returned:', riddle)
  const solution = await run(SOLVE_RIDDLE)
  console.log('[orch] solve  step returned:', solution)
})

export default wf
