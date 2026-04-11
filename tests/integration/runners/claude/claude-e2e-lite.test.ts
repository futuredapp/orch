import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import { step } from '../../../../src/core/step.ts'
import { type WorkflowDeps, workflow } from '../../../../src/core/workflow.ts'
import { claude } from '../../../../src/runners/index.ts'
import {
  BunClock,
  BunFsService,
  BunGitService,
  BunProcessService,
  path,
} from '../../../../src/services/index.ts'
import { FileStateStore, type RunId } from '../../../../src/state/index.ts'

const canRun = process.env.RUN_REAL_CLAUDE === '1' && Bun.which('claude') !== null

let tmpDir: string

afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

describe.skipIf(!canRun)('ClaudeRunner e2e-lite (workflow DSL + real CLI)', () => {
  it('runs a single-step workflow and persists completed state', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-claude-e2e-')
    const runIdVal = 'r-2026-04-11-e2e001' as RunId
    // `bare: false` so the CLI can use the dev machine's keychain auth.
    // `--bare` would force ANTHROPIC_API_KEY, which Claude Pro users don't have.
    const runner = claude({ bare: false })
    const STEP = step.define('say-ok', { agent: runner, prompt: 'Reply with exactly: OK' })

    const bunFs = new BunFsService()
    const processService = new BunProcessService()
    const deps: WorkflowDeps = {
      stateStore: new FileStateStore({ fs: bunFs, basePath: path(tmpDir) }),
      processService,
      clock: new BunClock(),
      runId: runIdVal,
      cwd: path(process.cwd()),
      fsService: bunFs,
      gitService: new BunGitService({ processService }),
    }

    const wf = workflow('e2e-lite', async (run) => {
      const result = await run(STEP)
      expect(result).toBeDefined()
    })

    await wf.execute(deps)

    const raw = await fs.readFile(`${tmpDir}/${runIdVal}/state.json`, 'utf-8')
    const state = JSON.parse(raw)
    expect(state.status).toBe('completed')
    expect(Object.keys(state.steps)).toHaveLength(1)
    expect(state.steps['say-ok']).toBeDefined()
    expect(state.steps['say-ok'].value).toBeDefined()
  }, 30_000)
})
