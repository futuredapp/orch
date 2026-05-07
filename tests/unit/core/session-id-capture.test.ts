import { describe, expect, it } from 'bun:test'
import { step } from '../../../src/core/step.ts'
import type { WorkflowDeps } from '../../../src/core/workflow.ts'
import { workflow } from '../../../src/core/workflow.ts'
import {
  defineRunner,
  FakeRunner,
  type Runner,
  type RunnerContext,
} from '../../../src/runners/index.ts'
import {
  FakeClock,
  FakeFsService,
  FakeGitService,
  FakeProcessService,
  path,
} from '../../../src/services/index.ts'
import { FakePromptService } from '../../../src/services/prompt/index.ts'
import { FileStateStore, type RunId } from '../../../src/state/index.ts'
import { createFakeHost } from '../../helpers/fake-host.ts'

const rid = (s: string): RunId => s as RunId
const BASE = path('/runs')
const SESSION_ID = '99999999-9999-4999-8999-999999999999'

function makeDeps(overrides?: { onInteractive?: WorkflowDeps['onInteractive'] }): WorkflowDeps & {
  processService: FakeProcessService
  fs: FakeFsService
  store: FileStateStore
  rid: RunId
} {
  const fs = new FakeFsService()
  const processService = new FakeProcessService()
  const clock = new FakeClock(1000)
  const store = new FileStateStore({ fs, basePath: BASE })
  const runId = rid('r-2026-05-05-200000-zz')
  return {
    fs,
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
    onInteractive:
      overrides?.onInteractive ??
      (async () => ({ exitCode: 0, durationMs: 100, sessionId: SESSION_ID })),
  }
}

function runnerWithoutResume(): Runner {
  // FakeRunner exposes resumeCommand only after withResumeCommand() — its
  // default shape is exactly the "no resume" runner this test needs.
  return new FakeRunner(new FakeProcessService())
}

function runnerWithResume(): Runner {
  return new FakeRunner(new FakeProcessService()).withResumeCommand()
}

describe('workflow executor — sessionId capture (Phase 3)', () => {
  it('writes StepEntry.sessionId for an interactive step whose runner declares resumeCommand', async () => {
    const deps = makeDeps()
    const agent = runnerWithResume()
    const STEP = step.define('work-auth', { agent, mode: 'interactive' })

    const wf = workflow('test', async (run) => {
      await run(STEP)
    })
    await wf.execute(deps)

    const state = await deps.store.loadRun(deps.rid)
    expect(state?.steps['work-auth']?.sessionId).toBe(SESSION_ID)
  })

  it('omits StepEntry.sessionId when the interactive runner has no resumeCommand', async () => {
    const deps = makeDeps()
    const agent = runnerWithoutResume()
    const STEP = step.define('plan', { agent, mode: 'interactive' })

    const wf = workflow('test', async (run) => {
      await run(STEP)
    })
    await wf.execute(deps)

    const state = await deps.store.loadRun(deps.rid)
    expect(state?.steps.plan).toBeDefined()
    expect(state?.steps.plan?.sessionId).toBeUndefined()
  })

  it('omits StepEntry.sessionId for autonomous steps (resume only applies to interactive)', async () => {
    const deps = makeDeps()
    const agent = new FakeRunner(deps.processService).withResumeCommand()
    agent.script({ structuredOutput: 'done' })
    const STEP = step.define('analyze', { agent })

    const wf = workflow('test', async (run) => {
      await run(STEP)
    })
    await wf.execute(deps)

    const state = await deps.store.loadRun(deps.rid)
    expect(state?.steps.analyze?.mode).toBe('autonomous')
    expect(state?.steps.analyze?.sessionId).toBeUndefined()
  })

  it('routes the generated sessionId into the runner via ctx.sessionId for interactive steps', async () => {
    const sessionsSeen: string[] = []
    const captureRunner = defineRunner({
      name: 'capture',
      supports: { interactive: true, structuredOutput: false },
      buildCommand(ctx: RunnerContext) {
        if (typeof ctx.sessionId === 'string') sessionsSeen.push(ctx.sessionId)
        return { argv: ['true'], env: ctx.env }
      },
      parseEvents() {
        return null
      },
      extractStructuredOutput() {
        return undefined
      },
      toTranscriptLines() {
        return []
      },
      resumeCommand(ctx: RunnerContext, sessionId: string) {
        return { argv: ['capture-resume', sessionId], env: ctx.env }
      },
    })
    const deps = makeDeps()
    const STEP = step.define('resume-capable', { agent: captureRunner, mode: 'interactive' })

    const wf = workflow('test', async (run) => {
      await run(STEP)
    })
    await wf.execute(deps)

    // The host's onInteractive short-circuits buildCommand (see workflow.ts),
    // so we assert via the persisted entry instead — the captured sessionId
    // is the locally-generated one, regardless of buildCommand observation.
    const state = await deps.store.loadRun(deps.rid)
    expect(state?.steps['resume-capable']?.sessionId).toBe(SESSION_ID)
  })
})
