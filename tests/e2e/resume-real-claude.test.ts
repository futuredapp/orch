import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import { step } from '../../src/core/step.ts'
import { type WorkflowDeps, workflow } from '../../src/core/workflow.ts'
import { claude, FakeRunner } from '../../src/runners/index.ts'
import {
  BunClock,
  BunFsService,
  BunGitService,
  BunProcessService,
  FakeProcessService,
  path,
} from '../../src/services/index.ts'
import { FileStateStore, type RunId } from '../../src/state/index.ts'
import { createFakeHost } from '../helpers/fake-host.ts'

const canRun = process.env.RUN_REAL_CLAUDE === '1' && Bun.which('claude') !== null

let tmpDir: string

afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

describe.skipIf(!canRun)('resume with real Claude (e2e)', () => {
  it('real Claude result survives memoization across a resume boundary', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-resume-e2e-')
    const runIdVal = 'r-2026-04-13-e2e001' as RunId
    const bunFs = new BunFsService()
    const realProcessService = new BunProcessService()

    // Step 1: real Claude — "Reply with exactly: OK"
    // Step 2: FakeRunner that crashes on first invocation
    // `bare: false` so the CLI can use the dev machine's keychain auth.
    const realRunner = claude({ bare: false })
    const STEP_1 = step.define('real-claude', {
      agent: realRunner,
      prompt: 'Reply with exactly: OK',
    })

    // First run: step 1 (real Claude) succeeds, step 2 crashes
    const fakePs1 = new FakeProcessService()
    const crashRunner = new FakeRunner(fakePs1)
    crashRunner.script({ failWith: { message: 'simulated crash' } })

    const STEP_2_CRASH = step.define('fake-step', { agent: crashRunner })

    const deps1: WorkflowDeps = {
      stateStore: new FileStateStore({ fs: bunFs, basePath: path(tmpDir) }),
      processService: realProcessService,
      clock: new BunClock(),
      runId: runIdVal,
      cwd: path(process.cwd()),
      fsService: bunFs,
      gitService: new BunGitService({ processService: realProcessService }),
      host: createFakeHost(),
    }

    const wf1 = workflow('resume-e2e', async (run) => {
      await run(STEP_1)
      await run(STEP_2_CRASH)
    })

    try {
      await wf1.execute(deps1)
    } catch {
      // expected — step 2 crashes
    }

    // Verify step 1 is cached and status is 'crashed'
    const crashedState = await deps1.stateStore.loadRun(runIdVal)
    expect(crashedState?.status).toBe('crashed')
    expect(crashedState?.steps['real-claude']).toBeDefined()
    expect(crashedState?.steps['real-claude']?.value).toBeDefined()
    expect(crashedState?.steps['fake-step']).toBeUndefined()

    // Resume: step 1 cached (real Claude NOT re-invoked), step 2 succeeds
    const fakePs2 = new FakeProcessService()
    const successRunner = new FakeRunner(fakePs2)
    successRunner.script({ structuredOutput: 'step-2-done' })

    const STEP_2_OK = step.define('fake-step', { agent: successRunner })

    const deps2: WorkflowDeps = {
      stateStore: new FileStateStore({ fs: bunFs, basePath: path(tmpDir) }),
      processService: realProcessService,
      clock: new BunClock(),
      runId: runIdVal,
      cwd: path(process.cwd()),
      fsService: bunFs,
      gitService: new BunGitService({ processService: realProcessService }),
      host: createFakeHost(),
    }

    const wf2 = workflow('resume-e2e', async (run) => {
      await run(step.define('real-claude', { agent: realRunner, prompt: 'Reply with exactly: OK' }))
      await run(STEP_2_OK)
    })
    await wf2.resume(deps2)

    // Real Claude was NOT re-invoked (cached), step 2 now succeeded
    expect(successRunner.invocationCount).toBe(1)

    const finalState = await deps2.stateStore.loadRun(runIdVal)
    expect(finalState?.status).toBe('completed')
    expect(Object.keys(finalState?.steps ?? {})).toHaveLength(2)
    expect(finalState?.steps['real-claude']?.value).toBeDefined()
    expect(finalState?.steps['fake-step']?.value).toBe('step-2-done')
  }, 60_000)
})
