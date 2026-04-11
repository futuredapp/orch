/**
 * hello-file — minimal end-to-end demo of the orch pipeline.
 *
 * Runs one workflow step that invokes the real `claude` CLI through
 * ClaudeRunner and asks it to write `hello.txt` into a sandbox directory.
 *
 * Usage:
 *   bun run examples/hello-file/index.ts
 *   bun run examples/hello-file/index.ts --run-id=r-2026-04-11-abc123
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

// `bare: false` is required for subscription/OAuth logins — `--bare` tells
// the claude CLI to read auth strictly from ANTHROPIC_API_KEY or
// `apiKeyHelper` and never from the keychain, which breaks Claude Pro users.
// No `maxTurns` — writing a single file still needs one tool-use turn plus
// a final summary turn, so capping at 1 bails before the file exists.
const CREATE_FILE = step.define('create-hello-file', {
  agent: claude({
    bare: false,
    flags: ['--permission-mode', 'bypassPermissions'],
  }),
  prompt:
    'Create a file at ./hello.txt containing exactly the text "Hello World" ' +
    '(no trailing newline, no code fences, no extra explanation).',
})

const deps: WorkflowDeps = {
  stateStore: new FileStateStore({ fs: new BunFsService(), basePath: path(stateDir) }),
  processService: new BunProcessService(),
  clock,
  runId: runIdVal,
  cwd: path(sandboxDir),
}

const wf = workflow('hello-file-demo', async (run) => {
  const result = await run(CREATE_FILE)
  console.log('[orch] claude returned:', result)
})

console.log(`[orch] runId   = ${runIdVal}`)
console.log(`[orch] sandbox = ${sandboxDir}`)
console.log(`[orch] state   = ${stateDir}`)

await wf.execute(deps)

console.log(`[orch] done. expect file at: ${nodePath.join(sandboxDir, 'hello.txt')}`)
