import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { step } from '../../../../src/core/step.ts'
import type { WorkflowDeps } from '../../../../src/core/workflow.ts'
import { workflow } from '../../../../src/core/workflow.ts'
import { claude } from '../../../../src/runners/index.ts'
import {
  FakeClock,
  FakeFsService,
  FakeGitService,
  FakeProcessService,
  path,
} from '../../../../src/services/index.ts'
import { FakePromptService } from '../../../../src/services/prompt/index.ts'
import { FileStateStore, type RunId } from '../../../../src/state/index.ts'
import { createFakeHost } from '../../../helpers/fake-host.ts'

const rid = (s: string): RunId => s as RunId
const BASE = path('/runs')

function loadFixtureLines(name: string): string[] {
  const filePath = resolve(import.meta.dir, '../../../fixtures/claude', name)
  return readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter((l) => l.trim() !== '')
}

function makeDeps(overrides?: {
  fs?: FakeFsService
  processService?: FakeProcessService
  runId?: RunId
}): WorkflowDeps & { processService: FakeProcessService; clock: FakeClock } {
  const fs = overrides?.fs ?? new FakeFsService()
  const processService = overrides?.processService ?? new FakeProcessService()
  const clock = new FakeClock(1000)
  return {
    fsService: fs,
    gitService: new FakeGitService(),
    processService,
    clock,
    stateStore: new FileStateStore({ fs, basePath: BASE }),
    runId: overrides?.runId ?? rid('r-2026-04-13-327523-xq'),
    cwd: path('/workspace'),
    host: createFakeHost(),
    promptService: new FakePromptService(),
    interactivity: 'interactive' as const,
  }
}

describe('ClaudeRunner crash+resume (mocked)', () => {
  it('step 1 memoized on resume, step 2 re-runs with success fixture', async () => {
    const runner = claude()
    const sharedFs = new FakeFsService()
    const sharedRunId = rid('r-2026-04-13-327523-xq')

    const STEP_1 = step.define('step-1', { agent: runner, prompt: 'do step 1' })
    const STEP_2 = step.define('step-2', { agent: runner, prompt: 'do step 2' })

    // First run: step 1 succeeds, step 2 fails
    const fps1 = new FakeProcessService()
    const deps1 = makeDeps({ fs: sharedFs, processService: fps1, runId: sharedRunId })

    const cmd1 = await runner.buildCommand({
      cwd: path('/workspace'),
      env: {},
      prompt: 'do step 1',
      extraArgs: [],
    })
    fps1.when(cmd1.argv).respondWith({
      stdout: loadFixtureLines('simple-success.jsonl'),
      exitCode: 0,
    })

    const cmd2 = await runner.buildCommand({
      cwd: path('/workspace'),
      env: {},
      prompt: 'do step 2',
      extraArgs: [],
    })
    fps1.when(cmd2.argv).respondWith({
      stdout: loadFixtureLines('error-max-turns.jsonl'),
      exitCode: 1,
    })

    const wf = workflow('claude-resume', async (run) => {
      await run(STEP_1)
      await run(STEP_2)
    })

    try {
      await wf.execute(deps1)
    } catch {
      // expected — step 2 error
    }

    const failed = await deps1.stateStore.loadRun(sharedRunId)
    expect(failed?.status).toBe('failed')
    expect(failed?.steps['step-1']?.value).toBe('OK')
    expect(failed?.steps['step-2']).toBeUndefined()

    // Resume: step 1 cached (FakeProcessService not re-invoked), step 2 succeeds
    const fps2 = new FakeProcessService()
    const deps2 = makeDeps({ fs: sharedFs, processService: fps2, runId: sharedRunId })

    // Only script step 2's response — step 1 should not be invoked
    fps2.when(cmd2.argv).respondWith({
      stdout: loadFixtureLines('simple-success.jsonl'),
      exitCode: 0,
    })

    await wf.resume(deps2)

    const finalState = await deps2.stateStore.loadRun(sharedRunId)
    expect(finalState?.status).toBe('completed')
    expect(finalState?.steps['step-1']?.value).toBe('OK')
    expect(finalState?.steps['step-2']?.value).toBe('OK')
    expect(Object.keys(finalState?.steps ?? {})).toHaveLength(2)
  })
})
