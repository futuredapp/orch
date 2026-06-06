import { describe, expect, it } from 'bun:test'
import { createFakeHost } from '@orch/test/fake-host.ts'
import { createResumeRegistry } from '../../../src/core/resume-registry.ts'
import { step } from '../../../src/core/step.ts'
import { stepName } from '../../../src/core/types.ts'
import type { WorkflowDeps } from '../../../src/core/workflow.ts'
import { workflow } from '../../../src/core/workflow.ts'
import { FakeRunner, type Runner } from '../../../src/runners/index.ts'
import {
  FakeClock,
  FakeFsService,
  FakeGitService,
  FakeProcessService,
  path,
} from '../../../src/services/index.ts'
import { FakePromptService } from '../../../src/services/prompt/index.ts'
import { FileStateStore, type RunId } from '../../../src/state/index.ts'

const SESSION_ID = '99999999-9999-4999-8999-999999999999'
const BASE = path('/runs')

function makeDeps(reg?: ReturnType<typeof createResumeRegistry>): WorkflowDeps & {
  store: FileStateStore
  rid: RunId
} {
  const fs = new FakeFsService()
  const processService = new FakeProcessService()
  const clock = new FakeClock(1000)
  const store = new FileStateStore({ fs, basePath: BASE })
  const runId = 'r-2026-05-13-300000-zz' as RunId
  return {
    rid: runId,
    store,
    fsService: fs,
    gitService: new FakeGitService(),
    processService,
    clock,
    stateStore: store,
    runId,
    cwd: path('/workspace'),
    host: createFakeHost(),
    promptService: new FakePromptService(),
    interactivity: 'interactive' as const,
    generateSessionId: () => SESSION_ID,
    onInteractive: async () => ({ exitCode: 0, durationMs: 100, sessionId: SESSION_ID }),
    ...(reg !== undefined ? { resumeRegistry: reg } : {}),
  }
}

function runnerWithResume(name = 'fake'): Runner {
  const inner = new FakeRunner(new FakeProcessService()).withResumeCommand()
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === 'name') return name
      const v = Reflect.get(target, prop)
      return typeof v === 'function' ? v.bind(target) : v
    },
  }) as Runner
}

describe('workflow executor — resume registry registration and runnerName persistence', () => {
  it('writes StepEntry.runnerName for an interactive agent step', async () => {
    const deps = makeDeps()
    const agent = runnerWithResume('claude')
    const STEP = step.define('plan', { agent, mode: 'interactive' })
    const wf = workflow('test', async (run) => {
      await run(STEP)
    })

    await wf.execute(deps)

    const state = await deps.store.loadRun(deps.rid)
    expect(state?.steps.plan?.runnerName).toBe('claude')
  })

  it('omits StepEntry.runnerName for autonomous agent steps', async () => {
    const deps = makeDeps()
    const agent = new FakeRunner(deps.processService as FakeProcessService).withResumeCommand()
    agent.script({ structuredOutput: 'done' })
    const STEP = step.define('analyze', { agent })
    const wf = workflow('test', async (run) => {
      await run(STEP)
    })

    await wf.execute(deps)

    const state = await deps.store.loadRun(deps.rid)
    expect(state?.steps.analyze?.mode).toBe('autonomous')
    expect(state?.steps.analyze?.runnerName).toBeUndefined()
  })

  it('registers the runner in the registry at the start of an interactive step', async () => {
    const reg = createResumeRegistry()
    const deps = makeDeps(reg)
    const agent = runnerWithResume('codex')
    const STEP = step.define('work', { agent, mode: 'interactive' })
    const wf = workflow('test', async (run) => {
      await run(STEP)
    })

    await wf.execute(deps)

    expect(reg.getRunnerForStep(stepName('work'))).toBe(agent)
  })

  it('does NOT register autonomous agent steps in the registry', async () => {
    const reg = createResumeRegistry()
    const deps = makeDeps(reg)
    const agent = new FakeRunner(deps.processService as FakeProcessService)
    agent.script({ structuredOutput: 'done' })
    const STEP = step.define('autonomous', { agent })
    const wf = workflow('test', async (run) => {
      await run(STEP)
    })

    await wf.execute(deps)

    expect(reg.getRunnerForStep(stepName('autonomous'))).toBeUndefined()
  })

  it('registers a cache-hit interactive step on replay so resumed runs progressively populate the registry', async () => {
    const firstRunReg = createResumeRegistry()
    const firstDeps = makeDeps(firstRunReg)
    const agent = runnerWithResume('claude')
    const STEP = step.define('plan', { agent, mode: 'interactive' })
    const wf = workflow('test', async (run) => {
      await run(STEP)
    })

    // First execution: writes the step entry to the state store.
    await wf.execute(firstDeps)
    expect(firstRunReg.getRunnerForStep(stepName('plan'))).toBe(agent)

    // Second execution against the SAME state store but a fresh registry —
    // step is now a cache hit, but the registry must still see the runner.
    const secondReg = createResumeRegistry()
    const secondDeps: WorkflowDeps = { ...firstDeps, resumeRegistry: secondReg }
    await wf.execute(secondDeps)

    expect(secondReg.getRunnerForStep(stepName('plan'))).toBe(agent)
  })

  it('a workflow with no resumeRegistry dep still executes (registry is optional)', async () => {
    const deps = makeDeps() // no resumeRegistry
    const agent = runnerWithResume('claude')
    const STEP = step.define('plan', { agent, mode: 'interactive' })
    const wf = workflow('test', async (run) => {
      await run(STEP)
    })

    await wf.execute(deps)

    const state = await deps.store.loadRun(deps.rid)
    expect(state?.steps.plan?.runnerName).toBe('claude')
  })
})
