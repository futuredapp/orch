import { describe, expect, it } from 'bun:test'
import { step } from '../../../src/core/step.ts'
import type { WorkflowDeps } from '../../../src/core/workflow.ts'
import { workflow } from '../../../src/core/workflow.ts'
import { FakeRunner } from '../../../src/runners/fake/index.ts'
import type { CaptureHandle, CaptureSessionIdContext } from '../../../src/runners/types.ts'
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
const ORCH_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const CAPTURED_THREAD_ID = '019303a4-4a8f-7c3f-9b8b-1234567890ab'

function makeDeps(overrides?: { runId?: RunId }): WorkflowDeps & {
  processService: FakeProcessService
  clock: FakeClock
  stateStore: FileStateStore
  host: FakeHost
} {
  const fs = new FakeFsService()
  const processService = new FakeProcessService()
  const clock = new FakeClock(1000)
  // Two-pane mode so the executor's view-resolution allows interactive steps;
  // FakeHost still records spawns into `interactiveSpawns` for assertions.
  const host = createFakeHost({ mode: 'two-pane' })
  host.setInteractiveResult({ exitCode: 0, durationMs: 4200 })
  return {
    fsService: fs,
    gitService: new FakeGitService(),
    processService,
    clock,
    stateStore: new FileStateStore({ fs, basePath: BASE }),
    runId: overrides?.runId ?? rid('r-2026-05-13-100001-cd'),
    cwd: path('/workspace'),
    host,
    promptService: new FakePromptService(),
    interactivity: 'interactive' as const,
    generateSessionId: () => ORCH_UUID,
  }
}

function captureReturning(
  outcome: { sessionId: string } | { error: 'ambiguous' | 'empty' | 'error' },
): (ctx: CaptureSessionIdContext) => CaptureHandle {
  return () => ({
    snapshotReady: Promise.resolve(),
    result: Promise.resolve(outcome),
  })
}

describe('workflow.execute — codex-style captureSessionId integration', () => {
  it('replaces the orch UUID with the captured thread_id when capture succeeds', async () => {
    const deps = makeDeps()

    const runner = new FakeRunner(deps.processService)
      .withResumeCommand()
      .withCaptureSessionId(captureReturning({ sessionId: CAPTURED_THREAD_ID }))
    // Interactive steps still call buildCommand; FakeRunner enforces that a
    // script slot is enqueued first even though host.runInteractive owns the
    // process lifetime.
    runner.script({})

    const STEP = step.define('codex-chat', {
      agent: runner,
      mode: 'interactive',
      prompt: 'design the auth flow',
    })

    const wf = workflow('dev', async (run) => {
      await run(STEP)
    })
    await wf.execute(deps)

    const state = await deps.stateStore.loadRun(deps.runId)
    const entry = state?.steps['codex-chat']
    expect(entry?.sessionId).toBe(CAPTURED_THREAD_ID)
    expect(entry?.runnerName).toBe('fake')
    expect(entry?.sessionIdCaptureError).toBeUndefined()
  })

  it('persists sessionIdCaptureError = ambiguous and omits sessionId when capture reports ambiguous', async () => {
    const deps = makeDeps({ runId: rid('r-2026-05-13-100002-cd') })

    const runner = new FakeRunner(deps.processService)
      .withResumeCommand()
      .withCaptureSessionId(captureReturning({ error: 'ambiguous' }))
    runner.script({})

    const STEP = step.define('codex-chat', {
      agent: runner,
      mode: 'interactive',
      prompt: 'codex prompt',
    })

    const wf = workflow('dev', async (run) => {
      await run(STEP)
    })
    await wf.execute(deps)

    const entry = (await deps.stateStore.loadRun(deps.runId))?.steps['codex-chat']
    expect(entry?.sessionId).toBeUndefined()
    expect(entry?.sessionIdCaptureError).toBe('ambiguous')
    expect(entry?.runnerName).toBe('fake')
  })

  it('persists sessionIdCaptureError = empty when capture reports empty', async () => {
    const deps = makeDeps({ runId: rid('r-2026-05-13-100003-cd') })

    const runner = new FakeRunner(deps.processService)
      .withResumeCommand()
      .withCaptureSessionId(captureReturning({ error: 'empty' }))
    runner.script({})

    const STEP = step.define('codex-chat', {
      agent: runner,
      mode: 'interactive',
      prompt: 'codex prompt',
    })

    await workflow('dev', async (run) => {
      await run(STEP)
    }).execute(deps)

    const entry = (await deps.stateStore.loadRun(deps.runId))?.steps['codex-chat']
    expect(entry?.sessionId).toBeUndefined()
    expect(entry?.sessionIdCaptureError).toBe('empty')
  })

  it('persists sessionIdCaptureError = error and is distinguishable from the empty variant', async () => {
    const deps = makeDeps({ runId: rid('r-2026-05-13-100004-cd') })

    const runner = new FakeRunner(deps.processService)
      .withResumeCommand()
      .withCaptureSessionId(captureReturning({ error: 'error' }))
    runner.script({})

    const STEP = step.define('codex-chat', {
      agent: runner,
      mode: 'interactive',
      prompt: 'codex prompt',
    })

    await workflow('dev', async (run) => {
      await run(STEP)
    }).execute(deps)

    const entry = (await deps.stateStore.loadRun(deps.runId))?.steps['codex-chat']
    expect(entry?.sessionIdCaptureError).toBe('error')
    expect(entry?.sessionIdCaptureError).not.toBe('empty')
  })

  it('keeps the orch UUID and writes runnerName when the runner declares no captureSessionId (Claude path)', async () => {
    const deps = makeDeps({ runId: rid('r-2026-05-13-100005-cd') })

    // FakeRunner without withCaptureSessionId — captureSessionId stays
    // undefined, mirroring Claude today.
    const runner = new FakeRunner(deps.processService).withResumeCommand()
    runner.script({})

    const STEP = step.define('claude-chat', {
      agent: runner,
      mode: 'interactive',
      prompt: 'claude prompt',
    })

    await workflow('dev', async (run) => {
      await run(STEP)
    }).execute(deps)

    const entry = (await deps.stateStore.loadRun(deps.runId))?.steps['claude-chat']
    expect(entry?.sessionId).toBe(ORCH_UUID)
    expect(entry?.runnerName).toBe('fake')
    expect(entry?.sessionIdCaptureError).toBeUndefined()
  })

  it('awaits snapshotReady before host.runInteractive is invoked', async () => {
    const deps = makeDeps({ runId: rid('r-2026-05-13-100006-cd') })

    const events: string[] = []

    // Hook the host to record the moment runInteractive fires.
    const originalRunInteractive = deps.host.runInteractive.bind(deps.host)
    deps.host.runInteractive = async (spawn) => {
      events.push('host.runInteractive')
      return originalRunInteractive(spawn)
    }

    let resolveSnapshot = (): void => {}
    const snapshotReady = new Promise<void>((res) => {
      resolveSnapshot = res
    })

    const runner = new FakeRunner(deps.processService)
      .withResumeCommand()
      .withCaptureSessionId(() => ({
        snapshotReady,
        result: Promise.resolve({ sessionId: CAPTURED_THREAD_ID }),
      }))
    runner.script({})

    const STEP = step.define('ordered', {
      agent: runner,
      mode: 'interactive',
      prompt: 'go',
    })

    const wfPromise = workflow('dev', async (run) => {
      await run(STEP)
    }).execute(deps)

    // Give the workflow a chance to enter the capture-await — runInteractive
    // must NOT have fired yet because snapshotReady is still pending.
    await new Promise((r) => setImmediate(r))
    expect(events).not.toContain('host.runInteractive')

    events.push('snapshotReady.resolve')
    resolveSnapshot()

    await wfPromise

    expect(events).toEqual(['snapshotReady.resolve', 'host.runInteractive'])
  })

  it('does not invoke captureSessionId for autonomous steps and writes no runnerName', async () => {
    const deps = makeDeps({ runId: rid('r-2026-05-13-100007-cd') })

    let captureInvoked = false
    const runner = new FakeRunner(deps.processService)
      .withResumeCommand()
      .withCaptureSessionId(() => {
        captureInvoked = true
        return {
          snapshotReady: Promise.resolve(),
          result: Promise.resolve({ sessionId: CAPTURED_THREAD_ID }),
        }
      })
      .script({ structuredOutput: 'autonomous-output' })

    const STEP = step.define('autonomous-codex', {
      agent: runner,
      prompt: 'autonomous prompt',
    })

    await workflow('dev', async (run) => {
      await run(STEP)
    }).execute(deps)

    expect(captureInvoked).toBe(false)
    const entry = (await deps.stateStore.loadRun(deps.runId))?.steps['autonomous-codex']
    expect(entry?.mode).toBe('autonomous')
    expect(entry?.runnerName).toBeUndefined()
  })
})
