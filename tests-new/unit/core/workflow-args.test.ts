import { describe, expect, it } from 'bun:test'
import { step } from '../../../src/core/step.ts'
import type { RunFn, WorkflowArgs, WorkflowDeps } from '../../../src/core/workflow.ts'
import { workflow } from '../../../src/core/workflow.ts'
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
import { createFakeHost } from '@orch/test/fake-host.ts'

const rid = (s: string): RunId => s as RunId
const BASE = path('/runs')

function makeDeps(args?: WorkflowArgs): WorkflowDeps {
  const fs = new FakeFsService()
  return {
    fs: fs,
    fsService: fs,
    gitService: new FakeGitService(),
    processService: new FakeProcessService(),
    clock: new FakeClock(1000),
    stateStore: new FileStateStore({ fs, basePath: BASE }),
    runId: rid('r-2026-04-14-031568-o6'),
    cwd: path('/workspace'),
    host: createFakeHost(),
    promptService: new FakePromptService(),
    interactivity: 'interactive' as const,
    ...(args !== undefined ? { args } : {}),
  } as WorkflowDeps
}

describe('workflow() args parameter', () => {
  it('delivers args.prompt to the callback when supplied via deps.args', async () => {
    const deps = makeDeps({ prompt: 'think hard' })
    const fr = new FakeRunner(deps.processService as FakeProcessService)
    fr.script({ structuredOutput: 'done' })
    const STEP = step.define('plan', { agent: fr })

    let captured: WorkflowArgs | undefined
    const wf = workflow('test', async (run, args) => {
      captured = args
      await run(STEP)
    })
    await wf.execute(deps)

    expect(captured).toEqual({ prompt: 'think hard' })
  })

  it('delivers an empty object when deps.args is omitted', async () => {
    const deps = makeDeps()
    const fr = new FakeRunner(deps.processService as FakeProcessService)
    fr.script({ structuredOutput: 'done' })
    const STEP = step.define('plan', { agent: fr })

    let captured: WorkflowArgs | undefined
    const wf = workflow('test', async (run, args) => {
      captured = args
      await run(STEP)
    })
    await wf.execute(deps)

    expect(captured).toEqual({})
  })

  it('preserves empty-string prompt as distinct from undefined', async () => {
    const deps = makeDeps({ prompt: '' })
    const fr = new FakeRunner(deps.processService as FakeProcessService)
    fr.script({ structuredOutput: 'done' })
    const STEP = step.define('plan', { agent: fr })

    let captured: WorkflowArgs | undefined
    const wf = workflow('test', async (run, args) => {
      captured = args
      await run(STEP)
    })
    await wf.execute(deps)

    expect(captured?.prompt).toBe('')
  })

  it('accepts a legacy single-parameter callback (async (run) => ...)', async () => {
    const deps = makeDeps({ prompt: 'ignored by legacy' })
    const fr = new FakeRunner(deps.processService as FakeProcessService)
    fr.script({ structuredOutput: 'done' })
    const STEP = step.define('plan', { agent: fr })

    let ran = false
    // Cast widens the arity; JS silently drops the second arg at runtime.
    const legacyFn = (async (run: RunFn) => {
      ran = true
      await run(STEP)
    }) as Parameters<typeof workflow>[1]
    const wf = workflow('test', legacyFn)
    await wf.execute(deps)

    expect(ran).toBe(true)
  })

  it('persists args into state.json via initRun', async () => {
    const deps = makeDeps({ prompt: 'remember me' })
    const fr = new FakeRunner(deps.processService as FakeProcessService)
    fr.script({ structuredOutput: 'done' })
    const STEP = step.define('plan', { agent: fr })

    const wf = workflow('test', async (run) => {
      await run(STEP)
    })
    await wf.execute(deps)

    const state = await deps.stateStore.loadRun(deps.runId)
    expect(state?.args).toEqual({ prompt: 'remember me' })
  })

  it('does not persist args when none were supplied', async () => {
    const deps = makeDeps()
    const fr = new FakeRunner(deps.processService as FakeProcessService)
    fr.script({ structuredOutput: 'done' })
    const STEP = step.define('plan', { agent: fr })

    const wf = workflow('test', async (run) => {
      await run(STEP)
    })
    await wf.execute(deps)

    const state = await deps.stateStore.loadRun(deps.runId)
    expect(state?.args).toBeUndefined()
  })
})
