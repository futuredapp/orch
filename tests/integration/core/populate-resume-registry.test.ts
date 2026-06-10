import { describe, expect, it } from 'bun:test'
import { createFakeHost } from '@orch/test/fake-host.ts'
import { createResumeRegistry } from '../../../src/core/index.ts'
import { step } from '../../../src/core/step.ts'
import type { StepName } from '../../../src/core/types.ts'
import type { WorkflowDeps } from '../../../src/core/workflow.ts'
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

// `executor.populateResumeRegistry` is the no-mutation replay that rehydrates
// the live runner registry when a finished run is RE-opened from a fresh
// process (`orch resume <completed-id>` / the failed park view). On a cold open
// there is no executor running, so the right-pane controller had no runner to
// resolve on `⏎` and refused with "resume not ready yet". This pass walks the
// workflow body, registers every interactive step's runner from the cache, and
// executes nothing — so `⏎` can relaunch the session exactly like the live
// end-of-run view.

const rid = (s: string): RunId => s as RunId
const STATE_BASE = path('/runs')

interface Deps extends WorkflowDeps {
  fsService: FakeFsService
  processService: FakeProcessService
  clock: FakeClock
}

function makeDeps(runId: string): Deps {
  const fs = new FakeFsService()
  const clock = new FakeClock(1000)
  return {
    fsService: fs,
    gitService: new FakeGitService(),
    processService: new FakeProcessService(),
    clock,
    stateStore: new FileStateStore({ fs, basePath: STATE_BASE }),
    runId: rid(runId),
    cwd: path('/workspace'),
    host: createFakeHost({ mode: 'two-pane' }),
    promptService: new FakePromptService(),
    interactivity: 'interactive' as const,
    generateSessionId: () => 'checkpoint-uuid',
  }
}

describe('executor.populateResumeRegistry — rehydrate the runner registry on a cold open', () => {
  it('registers a completed run interactive step runner against a fresh registry', async () => {
    const deps = makeDeps('r-2026-06-10-200001-aa')
    const chatRunner = new FakeRunner(deps.processService).withResumeCommand()
    chatRunner.script({ sessionId: 'sess-chat', structuredOutput: null })
    const buildRunner = new FakeRunner(deps.processService)
    buildRunner.script({ structuredOutput: 'built' })

    const CHAT = step.define('chat', { agent: chatRunner, mode: 'interactive' })
    const BUILD = step.define('build', { agent: buildRunner })
    const wf = workflow('chat-then-build', async (run) => {
      await run(CHAT)
      await run(BUILD)
    })

    await wf.execute(deps)

    const freshRegistry = createResumeRegistry()
    await wf.populateResumeRegistry({
      ...deps,
      resumeRegistry: freshRegistry,
      host: createFakeHost({ mode: 'two-pane' }),
    })

    expect(freshRegistry.getRunnerForStep('chat' as StepName)).toBe(chatRunner)
    // The registry is interactive-only — the autonomous build step is out of scope.
    expect(freshRegistry.getRunnerForStep('build' as StepName)).toBeUndefined()
  })

  it('invokes no runner, mutates no state, and emits no run:ended', async () => {
    const deps = makeDeps('r-2026-06-10-200002-bb')
    const chatRunner = new FakeRunner(deps.processService).withResumeCommand()
    chatRunner.script({ sessionId: 'sess-chat', structuredOutput: null })
    const buildRunner = new FakeRunner(deps.processService)
    buildRunner.script({ structuredOutput: 'built' })

    const CHAT = step.define('chat', { agent: chatRunner, mode: 'interactive' })
    const BUILD = step.define('build', { agent: buildRunner })
    const wf = workflow('chat-then-build', async (run) => {
      await run(CHAT)
      await run(BUILD)
    })

    await wf.execute(deps)
    const before = await deps.stateStore.loadRun(deps.runId)
    const chatInvocationsBefore = chatRunner.invocationCount
    const buildInvocationsBefore = buildRunner.invocationCount

    const replayHost = createFakeHost({ mode: 'two-pane' })
    await wf.populateResumeRegistry({
      ...deps,
      resumeRegistry: createResumeRegistry(),
      host: replayHost,
    })

    const after = await deps.stateStore.loadRun(deps.runId)
    expect(chatRunner.invocationCount).toBe(chatInvocationsBefore)
    expect(buildRunner.invocationCount).toBe(buildInvocationsBefore)
    expect(after?.status).toBe('completed')
    expect(after).toEqual(before)
    const ranEnded = replayHost.recorded.some(
      (e) => e.kind === 'lifecycle' && e.event.type === 'run:ended',
    )
    expect(ranEnded).toBe(false)
  })

  it('registers the failed interactive step then stops without re-running it', async () => {
    const execHost = createFakeHost({ mode: 'two-pane' })
    const deps: Deps = { ...makeDeps('r-2026-06-10-200003-cc'), host: execHost }
    const buildRunner = new FakeRunner(deps.processService)
    buildRunner.script({ structuredOutput: 'built' })
    const chatRunner = new FakeRunner(deps.processService).withResumeCommand()
    chatRunner.script({ sessionId: 'sess-chat', structuredOutput: null })

    const BUILD = step.define('build', { agent: buildRunner })
    const CHAT = step.define('chat', { agent: chatRunner, mode: 'interactive' })
    const wf = workflow('build-then-chat', async (run) => {
      await run(BUILD)
      await run(CHAT)
    })

    // The interactive step fails: the host reports a non-zero exit, so the run
    // ends `failed` with `chat` never persisted as a success (uncached).
    execHost.setInteractiveResult({ exitCode: 7, durationMs: 0 })
    await wf.execute(deps).catch(() => {})
    const failed = await deps.stateStore.loadRun(deps.runId)
    expect(failed?.status).toBe('failed')
    const chatInvocationsBefore = chatRunner.invocationCount

    const freshRegistry = createResumeRegistry()
    await wf.populateResumeRegistry({
      ...deps,
      resumeRegistry: freshRegistry,
      host: createFakeHost({ mode: 'two-pane' }),
    })

    // The failed interactive step is registered (register-before-cache), so the
    // user can still inspect it — but populate stopped before re-running it.
    expect(freshRegistry.getRunnerForStep('chat' as StepName)).toBe(chatRunner)
    expect(chatRunner.invocationCount).toBe(chatInvocationsBefore)
    expect((await deps.stateStore.loadRun(deps.runId))?.status).toBe('failed')
  })
})
