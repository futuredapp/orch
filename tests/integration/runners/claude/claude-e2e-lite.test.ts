import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import { step } from '../../../../src/core/step.ts'
import { type WorkflowDeps, workflow } from '../../../../src/core/workflow.ts'
import { claude } from '../../../../src/runners/index.ts'
import {
  BunFsService,
  BunProcessService,
  path,
  SystemClock,
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
    const runIdVal = 'r-2026-04-11-e2e1' as RunId
    const runner = claude({ maxTurns: 1 })
    const STEP = step.define('say-ok', { agent: runner, prompt: 'Reply with exactly: OK' })

    const deps: WorkflowDeps = {
      stateStore: new FileStateStore({ fs: new BunFsService(), basePath: path(tmpDir) }),
      processService: new BunProcessService(),
      clock: new SystemClock(),
      runId: runIdVal,
      cwd: path(process.cwd()),
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
