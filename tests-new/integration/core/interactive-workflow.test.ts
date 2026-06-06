import { describe, expect, it } from 'bun:test'
import { step } from '../../../src/core/step.ts'
import type { InteractiveResult } from '../../../src/core/types.ts'
import type { StepLifecycleEvent, WorkflowDeps } from '../../../src/core/workflow.ts'
import { workflow } from '../../../src/core/workflow.ts'
import { claude } from '../../../src/runners/index.ts'
import {
  FakeClock,
  FakeFsService,
  FakeGitService,
  FakeProcessService,
  path,
} from '../../../src/services/index.ts'
import { FakePromptService } from '../../../src/services/prompt/index.ts'
import { FileStateStore, type RunId } from '../../../src/state/index.ts'
import { createFakeHost, type FakeHost } from '@orch/test/fake-host.ts'

const rid = (s: string): RunId => s as RunId
const BASE = path('/runs')

function makeDeps(overrides?: {
  fs?: FakeFsService
  processService?: FakeProcessService
  runId?: RunId
  generateSessionId?: () => string
  onInteractive?: WorkflowDeps['onInteractive']
  host?: FakeHost
}): WorkflowDeps & {
  processService: FakeProcessService
  clock: FakeClock
  stateStore: FileStateStore
  host: FakeHost
} {
  const fs = overrides?.fs ?? new FakeFsService()
  const processService = overrides?.processService ?? new FakeProcessService()
  const clock = new FakeClock(1000)
  const host = overrides?.host ?? createFakeHost()
  return {
    fsService: fs,
    gitService: new FakeGitService(),
    processService,
    clock,
    stateStore: new FileStateStore({ fs, basePath: BASE }),
    runId: overrides?.runId ?? rid('r-2026-04-14-636616-oi'),
    cwd: path('/workspace'),
    host,
    promptService: new FakePromptService(),
    interactivity: 'interactive' as const,
    generateSessionId: overrides?.generateSessionId,
    onInteractive: overrides?.onInteractive,
  }
}

describe('interactive workflow mocked round-trip', () => {
  it('interactive step followed by autonomous step produces correct state', async () => {
    const deps = makeDeps({
      generateSessionId: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      onInteractive: async () => ({
        exitCode: 0,
        durationMs: 10000,
        sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      }),
    })

    const runner = claude()

    // Script the autonomous step
    const autonomousCmd = await runner.buildCommand({
      cwd: path('/workspace'),
      env: {},
      prompt: 'implement the plan',
      extraArgs: [],
    })
    const successLine = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'Implementation complete',
      session_id: 'sess-auto',
      duration_ms: 5000,
      duration_api_ms: 4000,
      is_error: false,
      num_turns: 3,
      total_cost_usd: 0.05,
      usage: {
        input_tokens: 100,
        output_tokens: 200,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    })
    deps.processService.when(autonomousCmd.argv).respondWith({
      stdout: [successLine],
      exitCode: 0,
    })

    const BRAINSTORM = step.define('brainstorm', {
      agent: runner,
      mode: 'interactive',
      prompt: 'brainstorm the auth redesign',
    })
    const WORK = step.define('work', {
      agent: runner,
      prompt: 'implement the plan',
    })

    let brainstormResult: unknown
    let workResult: unknown
    const wf = workflow('dev', async (run) => {
      brainstormResult = await run(BRAINSTORM)
      workResult = await run(WORK)
    })
    await wf.execute(deps)

    // Verify interactive result
    const ir = brainstormResult as InteractiveResult
    expect(ir.exitCode).toBe(0)
    expect(ir.durationMs).toBe(10000)
    expect(ir.sessionId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')

    // Verify autonomous result
    expect(workResult).toBe('Implementation complete')

    // Verify state
    const state = await deps.stateStore.loadRun(deps.runId)
    expect(state?.status).toBe('completed')
    expect(state?.steps.brainstorm?.mode).toBe('interactive')
    expect(state?.steps.work?.mode).toBe('autonomous')

    // Verify lifecycle events — pulled from the FakeHost's recorded buffer.
    const events: StepLifecycleEvent[] = deps.host.recorded
      .filter((r): r is { kind: 'lifecycle'; event: StepLifecycleEvent } => r.kind === 'lifecycle')
      .map((r) => r.event)
    expect(events).toHaveLength(4)
    const [e0, e1, e2, e3] = events
    if (e0?.type !== 'step:start') throw new Error(`expected step:start, got ${e0?.type}`)
    expect(e0.stepName as string).toBe('brainstorm')
    expect(e1?.type).toBe('step:complete')
    if (e2?.type !== 'step:start') throw new Error(`expected step:start, got ${e2?.type}`)
    expect(e2.stepName as string).toBe('work')
    expect(e3?.type).toBe('step:complete')
  })

  it('mode override at run() call site overrides step config', async () => {
    const deps = makeDeps({
      runId: rid('r-2026-04-14-414240-6m'),
      generateSessionId: () => 'ffffffff-ffff-ffff-ffff-ffffffffffff',
      onInteractive: async () => ({
        exitCode: 0,
        durationMs: 3000,
        sessionId: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
      }),
    })

    const runner = claude()

    // Define step as autonomous, but override to interactive at call site
    const PLAN = step.define('plan', {
      agent: runner,
      prompt: 'create a plan',
    })

    let result: unknown
    const wf = workflow('test', async (run) => {
      result = await run(PLAN, { mode: 'interactive' })
    })
    await wf.execute(deps)

    const ir = result as InteractiveResult
    expect(ir.exitCode).toBe(0)
    expect(ir.sessionId).toBe('ffffffff-ffff-ffff-ffff-ffffffffffff')
  })
})
