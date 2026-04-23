import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'
import { step } from '../../../src/core/step.ts'
import { type WorkflowDeps, workflow } from '../../../src/core/workflow.ts'
import { FakeRunner } from '../../../src/runners/index.ts'
import {
  BunFsService,
  FakeClock,
  FakeGitService,
  FakeProcessService,
  path,
} from '../../../src/services/index.ts'
import { FileStateStore, type RunId } from '../../../src/state/index.ts'
import { __resetValidatorRegistryForTests } from '../../../src/validators/define-validator.ts'
import {
  defineValidator,
  fileProduced,
  ValidationError,
  type Validator,
} from '../../../src/validators/index.ts'
import { createFakeHost } from '../../helpers/fake-host.ts'

let tmpDir: string

afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
  __resetValidatorRegistryForTests()
})

function makeDeps(cwd: string, basePath: string): WorkflowDeps {
  const bunFs = new BunFsService()
  return {
    stateStore: new FileStateStore({ fs: bunFs, basePath: path(basePath) }),
    processService: new FakeProcessService(),
    clock: new FakeClock(1000),
    runId: 'r-2026-04-11-wf0001' as RunId,
    cwd: path(cwd),
    fsService: bunFs,
    gitService: new FakeGitService(),
    host: createFakeHost(),
  }
}

describe('workflow + validators (full pipeline integration)', () => {
  it('throws ValidationError and leaves no StepEntry when fileProduced fails against a real temp dir', async () => {
    tmpDir = await fs.mkdtemp(nodePath.join('/tmp', 'orch-vw-'))
    const cwd = await fs.mkdtemp(nodePath.join('/tmp', 'orch-vw-cwd-'))
    const deps = makeDeps(cwd, tmpDir)

    const runner = new FakeRunner(deps.processService as FakeProcessService)
    runner.script({ structuredOutput: 'ok' })

    const STEP = step.define('plan', {
      agent: runner,
      validate: fileProduced('out/*.txt'),
    })

    let caught: unknown
    try {
      await workflow('t', async (run) => {
        await run(STEP)
      }).execute(deps)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(ValidationError)
    const ve = caught as ValidationError
    expect(ve.failures[0]?.name).toBe('fileProduced(out/*.txt)')

    const state = await deps.stateStore.loadRun(deps.runId)
    expect(state?.status).toBe('crashed')
    expect(state?.steps.plan).toBeUndefined()

    await fs.rm(cwd, { recursive: true, force: true })
  })

  it('persists StepEntry.validations to disk and reads it back via FileStateStore', async () => {
    tmpDir = await fs.mkdtemp(nodePath.join('/tmp', 'orch-vw-'))
    const cwd = await fs.mkdtemp(nodePath.join('/tmp', 'orch-vw-cwd-'))
    // Seed a file that satisfies the validator.
    await fs.mkdir(nodePath.join(cwd, 'out'), { recursive: true })
    await fs.writeFile(nodePath.join(cwd, 'out', 'result.txt'), 'done')

    const deps = makeDeps(cwd, tmpDir)
    const runner = new FakeRunner(deps.processService as FakeProcessService)
    runner.script({ structuredOutput: 'ok' })

    const STEP = step.define('plan', {
      agent: runner,
      validate: fileProduced('out/*.txt'),
    })

    await workflow('t', async (run) => {
      await run(STEP)
    }).execute(deps)

    // Read the state.json back through a fresh store instance to prove
    // the round-trip survives disk + Zod parse.
    const freshStore = new FileStateStore({ fs: new BunFsService(), basePath: path(tmpDir) })
    const state = await freshStore.loadRun(deps.runId)
    expect(state?.status).toBe('completed')
    expect(state?.steps.plan?.validations).toEqual([{ name: 'fileProduced(out/*.txt)', ok: true }])

    await fs.rm(cwd, { recursive: true, force: true })
  })

  it('persists 20+ validators through the atomic-write path without corruption', async () => {
    tmpDir = await fs.mkdtemp(nodePath.join('/tmp', 'orch-vw-'))
    const cwd = await fs.mkdtemp(nodePath.join('/tmp', 'orch-vw-cwd-'))
    const deps = makeDeps(cwd, tmpDir)
    const runner = new FakeRunner(deps.processService as FakeProcessService)
    runner.script({ structuredOutput: 'ok' })

    const validators: Validator[] = []
    for (let i = 0; i < 22; i++) {
      validators.push(defineValidator(`v-${i}`, () => true))
    }
    const STEP = step.define('plan', { agent: runner, validate: validators })

    await workflow('t', async (run) => {
      await run(STEP)
    }).execute(deps)

    const freshStore = new FileStateStore({ fs: new BunFsService(), basePath: path(tmpDir) })
    const state = await freshStore.loadRun(deps.runId)
    expect(state?.steps.plan?.validations).toHaveLength(22)
    expect(state?.steps.plan?.validations.every((v) => v.ok === true)).toBe(true)

    await fs.rm(cwd, { recursive: true, force: true })
  })
})
