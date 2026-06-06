// MIGRATED → tests-new/unit/core/workflow-validators.test.ts (parent U10) — relocated verbatim (import paths only); kept skipped on disk (D2).
import { describe, expect, it } from 'bun:test'
import { step } from '../../../src/core/step.ts'
import { StepError, type WorkflowDeps, workflow } from '../../../src/core/workflow.ts'
import { FakeRunner } from '../../../src/runners/index.ts'
import {
  FakeClock,
  FakeFsService,
  FakeGitService,
  FakeProcessService,
  path,
} from '../../../src/services/index.ts'
import { FakePromptService } from '../../../src/services/prompt/index.ts'
import { FileStateStore, type RunId } from '../../../src/state/index.ts'
import {
  ValidationError,
  type Validator,
  type ValidatorResult,
} from '../../../src/validators/index.ts'
import { createFakeHost } from '../../helpers/fake-host.ts'

const rid = (s: string): RunId => s as RunId
const BASE = path('/runs')

interface TestDeps extends WorkflowDeps {
  readonly fs: FakeFsService
  readonly processService: FakeProcessService
  readonly clock: FakeClock
  readonly gitService: FakeGitService
}

function makeDeps(): TestDeps {
  const fs = new FakeFsService()
  const processService = new FakeProcessService()
  const clock = new FakeClock(1000)
  const gitService = new FakeGitService()
  return {
    fs,
    fsService: fs,
    gitService,
    processService,
    clock,
    stateStore: new FileStateStore({ fs, basePath: BASE }),
    runId: rid('r-2026-04-10-458000-q8'),
    cwd: path('/workspace'),
    host: createFakeHost(),
    promptService: new FakePromptService(),
    interactivity: 'interactive' as const,
  }
}

/** Tiny recording wrapper that counts `headSha` calls through a fake. */
class CountingGit extends FakeGitService {
  headShaCallCount = 0
  override async headSha(cwd: Parameters<FakeGitService['headSha']>[0]): Promise<string> {
    this.headShaCallCount += 1
    return super.headSha(cwd)
  }
}

function passingValidator(name: string, needsHeadSha = false): Validator {
  return {
    name,
    ...(needsHeadSha ? { needs: ['headSha' as const] } : {}),
    async run(): Promise<ValidatorResult> {
      return { ok: true }
    },
  }
}

function failingValidator(name: string, reason: string, hint?: string): Validator {
  return {
    name,
    async run(): Promise<ValidatorResult> {
      return hint === undefined ? { ok: false, reason } : { ok: false, reason, hint }
    },
  }
}

describe.skip('workflow validator wiring', () => {
  it('captures preRunSnapshot.headSha before the runner is invoked when a validator needs it', async () => {
    const deps = makeDeps()
    deps.gitService.setHeadSha(deps.cwd, 'abc1234')

    const fr = new FakeRunner(deps.processService)
    fr.script({ structuredOutput: 'ok' })

    let captured: string | undefined
    const checkBaseline: Validator = {
      name: 'checkBaseline',
      needs: ['headSha' as const],
      async run(_svc, ctx) {
        captured = ctx.preRunSnapshot?.headSha
        return { ok: true }
      },
    }
    const STEP = step.define('plan', { agent: fr, validate: checkBaseline })

    await workflow('t', async (run) => {
      await run(STEP)
    }).execute(deps)

    expect(captured).toBe('abc1234')
    const state = await deps.stateStore.loadRun(deps.runId)
    expect(state?.steps.plan?.preRunSnapshot?.headSha).toBe('abc1234')
  })

  it('persists one PersistedValidation entry per passing validator', async () => {
    const deps = makeDeps()
    const fr = new FakeRunner(deps.processService)
    fr.script({ structuredOutput: 'ok' })
    const STEP = step.define('plan', {
      agent: fr,
      validate: [passingValidator('v1'), passingValidator('v2')],
    })

    await workflow('t', async (run) => {
      await run(STEP)
    }).execute(deps)

    const state = await deps.stateStore.loadRun(deps.runId)
    expect(state?.steps.plan?.validations).toEqual([
      { name: 'v1', ok: true },
      { name: 'v2', ok: true },
    ])
  })

  it('does not persist a StepEntry and throws ValidationError when a single validator fails', async () => {
    const deps = makeDeps()
    const fr = new FakeRunner(deps.processService)
    fr.script({ structuredOutput: 'ok' })
    const STEP = step.define('plan', {
      agent: fr,
      validate: failingValidator('v1', 'missing thing', 'add it'),
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
    expect(ve.failures).toEqual([{ name: 'v1', reason: 'missing thing', hint: 'add it' }])

    const state = await deps.stateStore.loadRun(deps.runId)
    expect(state?.steps.plan).toBeUndefined()
    expect(state?.status).toBe('failed')
  })

  it('runs every validator (no fail-fast) and aggregates all failures in order', async () => {
    const deps = makeDeps()
    const fr = new FakeRunner(deps.processService)
    fr.script({ structuredOutput: 'ok' })
    const STEP = step.define('plan', {
      agent: fr,
      validate: [
        failingValidator('v1', 'first'),
        passingValidator('v2'),
        failingValidator('v3', 'third'),
      ],
    })

    let caught: unknown
    try {
      await workflow('t', async (run) => {
        await run(STEP)
      }).execute(deps)
    } catch (err) {
      caught = err
    }

    const ve = caught as ValidationError
    expect(ve.failures.map((f) => f.name)).toEqual(['v1', 'v3'])
    expect(ve.failures.map((f) => f.reason)).toEqual(['first', 'third'])
  })

  it('normalizes thrown exceptions inside a validator into a failure with the error message', async () => {
    const deps = makeDeps()
    const fr = new FakeRunner(deps.processService)
    fr.script({ structuredOutput: 'ok' })
    const throwing: Validator = {
      name: 'boom',
      async run(): Promise<ValidatorResult> {
        throw new Error('validator exploded')
      },
    }
    const STEP = step.define('plan', { agent: fr, validate: throwing })

    let caught: unknown
    try {
      await workflow('t', async (run) => {
        await run(STEP)
      }).execute(deps)
    } catch (err) {
      caught = err
    }

    const ve = caught as ValidationError
    expect(ve.failures).toEqual([{ name: 'boom', reason: 'validator exploded' }])
  })

  it('short-circuits with StepError before running any validator on a failing runner', async () => {
    const deps = makeDeps()
    const fr = new FakeRunner(deps.processService)
    fr.script({ failWith: { message: 'runner crash', exitCode: 3 } })

    let validatorCalled = false
    const spy: Validator = {
      name: 'spy',
      async run(): Promise<ValidatorResult> {
        validatorCalled = true
        return { ok: true }
      },
    }
    const STEP = step.define('plan', { agent: fr, validate: spy })

    let caught: unknown
    try {
      await workflow('t', async (run) => {
        await run(STEP)
      }).execute(deps)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(StepError)
    expect(validatorCalled).toBe(false)
  })

  it('resume path: a cached step returns value without calling headSha and without re-running validators', async () => {
    const deps = makeDeps()
    // Seed cache with an existing step entry.
    await deps.stateStore.saveStep(deps.runId, {
      name: 'plan',
      value: { cached: true },
      startedAt: 0,
      endedAt: 1,
      artifacts: [],
      validations: [],
      transcriptEventCount: 0,
      transcriptTruncated: false,
    })

    const counting = new CountingGit()
    const depsWithCount: TestDeps = { ...deps, gitService: counting }

    let validatorCalled = false
    const spy: Validator = {
      name: 'spy',
      needs: ['headSha' as const],
      async run(): Promise<ValidatorResult> {
        validatorCalled = true
        return { ok: true }
      },
    }

    const fr = new FakeRunner(depsWithCount.processService)
    fr.script({ structuredOutput: 'should-not-run' })
    const STEP = step.define('plan', { agent: fr, validate: spy })

    let result: unknown
    await workflow('t', async (run) => {
      result = await run(STEP)
    }).execute(depsWithCount)

    expect(result).toEqual({ cached: true })
    expect(counting.headShaCallCount).toBe(0)
    expect(validatorCalled).toBe(false)
    expect(fr.invocationCount).toBe(0)
  })

  it('treats validate: single vs validate: array identically', async () => {
    const depsA = makeDeps()
    const frA = new FakeRunner(depsA.processService)
    frA.script({ structuredOutput: 'ok' })
    const vSingle: Validator = passingValidator('v1')
    const STEP_A = step.define('plan', { agent: frA, validate: vSingle })
    await workflow('t', async (run) => {
      await run(STEP_A)
    }).execute(depsA)

    const depsB = makeDeps()
    const frB = new FakeRunner(depsB.processService)
    frB.script({ structuredOutput: 'ok' })
    const STEP_B = step.define('plan', { agent: frB, validate: [vSingle] })
    await workflow('t', async (run) => {
      await run(STEP_B)
    }).execute(depsB)

    const stateA = await depsA.stateStore.loadRun(depsA.runId)
    const stateB = await depsB.stateStore.loadRun(depsB.runId)
    expect(stateA?.steps.plan?.validations).toEqual([{ name: 'v1', ok: true }])
    expect(stateB?.steps.plan?.validations).toEqual([{ name: 'v1', ok: true }])
  })

  it('does not call gitService.headSha when no validator declares needs: headSha', async () => {
    const counting = new CountingGit()
    const deps = makeDeps()
    const depsWithCount: TestDeps = { ...deps, gitService: counting }

    const fr = new FakeRunner(depsWithCount.processService)
    fr.script({ structuredOutput: 'ok' })
    const STEP = step.define('plan', { agent: fr, validate: passingValidator('v1') })

    await workflow('t', async (run) => {
      await run(STEP)
    }).execute(depsWithCount)

    expect(counting.headShaCallCount).toBe(0)
  })

  it('safeHeadSha returns undefined on a non-git cwd without crashing the workflow', async () => {
    const deps = makeDeps()
    // FakeGitService throws on unscripted headSha — but safeHeadSha only
    // swallows GitCommandError, not arbitrary Error. Use a custom shim.
    class NonRepoGit extends FakeGitService {
      override async headSha(): Promise<string> {
        const { GitCommandError } = await import('../../../src/services/index.ts')
        throw new GitCommandError(128, '', 'not a git repository')
      }
    }
    const depsShim: TestDeps = { ...deps, gitService: new NonRepoGit() }

    const fr = new FakeRunner(depsShim.processService)
    fr.script({ structuredOutput: 'ok' })

    let snapshotSeen: unknown
    const spy: Validator = {
      name: 'spy',
      needs: ['headSha' as const],
      async run(_svc, ctx) {
        snapshotSeen = ctx.preRunSnapshot
        return { ok: true }
      },
    }
    const STEP = step.define('plan', { agent: fr, validate: spy })

    await workflow('t', async (run) => {
      await run(STEP)
    }).execute(depsShim)

    expect(snapshotSeen).toBeUndefined()
    const state = await depsShim.stateStore.loadRun(depsShim.runId)
    expect(state?.status).toBe('completed')
    expect(state?.steps.plan?.preRunSnapshot).toBeUndefined()
  })
})
