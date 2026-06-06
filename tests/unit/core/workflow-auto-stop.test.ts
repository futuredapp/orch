// MIGRATED → tests-new/unit/core/workflow-auto-stop.test.ts (parent U10) — relocated verbatim (import paths only); kept skipped on disk (D2).
import { describe, expect, it } from 'bun:test'
import { AutoStopUnsupportedError } from '../../../src/core/errors.ts'
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
import { createFakeHost, type FakeHost } from '../../helpers/fake-host.ts'

const BASE = path('/runs')

function makeDeps(overrides?: { host?: FakeHost }): WorkflowDeps & { host: FakeHost } {
  const fs = new FakeFsService()
  const host = overrides?.host ?? createFakeHost({ mode: 'two-pane' })
  return {
    fsService: fs,
    gitService: new FakeGitService(),
    processService: new FakeProcessService(),
    clock: new FakeClock(1000),
    stateStore: new FileStateStore({ fs, basePath: BASE }),
    runId: 'r-2026-05-25-000000-aa' as RunId,
    cwd: path('/workspace'),
    host,
    promptService: new FakePromptService(),
    interactivity: 'interactive' as const,
  }
}

/** A runner that supports interactive + auto-stop, with counters so tests can
 *  prove prepareAutoStop/cleanup are invoked the expected number of times. */
function makeAutoStopRunner(prepEnv: Readonly<Record<string, string>> = {}): {
  runner: Runner
  state: { prepareCalls: number; cleanupCalls: number }
} {
  const state = { prepareCalls: 0, cleanupCalls: 0 }
  const runner = defineRunner({
    name: 'auto-fake',
    supports: { interactive: true, structuredOutput: false },
    buildCommand: (ctx: RunnerContext) => ({ argv: ['auto'], env: { BASE: '1', ...ctx.env } }),
    parseEvents: () => null,
    extractStructuredOutput: () => undefined,
    toTranscriptLines: () => [],
    prepareAutoStop: async () => {
      state.prepareCalls++
      return {
        env: prepEnv,
        cleanup: async () => {
          state.cleanupCalls++
        },
      }
    },
  })
  return { runner, state }
}

describe.skip('interactive auto-stop fail-fast', () => {
  it('throws AutoStopUnsupportedError before any host spawn when the runner lacks prepareAutoStop', async () => {
    const deps = makeDeps()
    const agent = new FakeRunner(deps.processService as FakeProcessService, {
      supportsAutoStop: false,
    })
    const STEP = step.define('brainstorm', { agent, mode: 'interactive', autoStop: true })

    let caught: unknown
    try {
      await workflow('test', async (run) => {
        await run(STEP)
      }).execute(deps)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(AutoStopUnsupportedError)
    expect((caught as AutoStopUnsupportedError).runnerName).toBe('fake')
    expect(deps.host.interactiveSpawns).toHaveLength(0)
  })
})

describe.skip('interactive auto-stop wiring', () => {
  it('calls prepareAutoStop once and passes autoStop:true to the host', async () => {
    const deps = makeDeps()
    const { runner, state } = makeAutoStopRunner()
    const STEP = step.define('brainstorm', { agent: runner, mode: 'interactive', autoStop: true })

    await workflow('test', async (run) => {
      await run(STEP)
    }).execute(deps)

    expect(state.prepareCalls).toBe(1)
    expect(deps.host.interactiveSpawns).toHaveLength(1)
    expect(deps.host.interactiveSpawns[0]?.autoStop).toBe(true)
  })

  it('merges the env returned by prepareAutoStop into the spawn env handed to the host', async () => {
    const deps = makeDeps()
    const { runner } = makeAutoStopRunner({ CODEX_HOME: '/tmp/orch-codex-x' })
    const STEP = step.define('brainstorm', { agent: runner, mode: 'interactive', autoStop: true })

    await workflow('test', async (run) => {
      await run(STEP)
    }).execute(deps)

    const spawnEnv = deps.host.interactiveSpawns[0]?.env
    expect(spawnEnv?.CODEX_HOME).toBe('/tmp/orch-codex-x')
    expect(spawnEnv?.BASE).toBe('1')
  })

  it('cleans up the prepared auto-stop artifact after the interactive spawn', async () => {
    const deps = makeDeps()
    const { runner, state } = makeAutoStopRunner()
    const STEP = step.define('brainstorm', { agent: runner, mode: 'interactive', autoStop: true })

    await workflow('test', async (run) => {
      await run(STEP)
    }).execute(deps)

    const onCleanup = deps.host.interactiveSpawns[0]?.onCleanup
    expect(typeof onCleanup).toBe('function')
    expect(state.cleanupCalls).toBe(1)
    await onCleanup?.()
    expect(state.cleanupCalls).toBe(1)
  })

  it('cleans up when the host spawn path throws before host-owned cleanup can run', async () => {
    const deps = makeDeps()
    const originalRunInteractive = deps.host.runInteractive.bind(deps.host)
    deps.host.runInteractive = async (spawn) => {
      await originalRunInteractive(spawn)
      throw new Error('register failed')
    }
    const { runner, state } = makeAutoStopRunner()
    const STEP = step.define('brainstorm', { agent: runner, mode: 'interactive', autoStop: true })

    await expect(
      workflow('test', async (run) => {
        await run(STEP)
      }).execute(deps),
    ).rejects.toThrow('register failed')

    expect(state.cleanupCalls).toBe(1)
  })

  it('does not double-clean when the host also invokes the cleanup handle', async () => {
    const deps = makeDeps()
    const originalRunInteractive = deps.host.runInteractive.bind(deps.host)
    deps.host.runInteractive = async (spawn) => {
      const result = await originalRunInteractive(spawn)
      await spawn.onCleanup?.()
      return result
    }
    const { runner, state } = makeAutoStopRunner()
    const STEP = step.define('brainstorm', { agent: runner, mode: 'interactive', autoStop: true })

    await workflow('test', async (run) => {
      await run(STEP)
    }).execute(deps)

    expect(state.cleanupCalls).toBe(1)
  })

  it('never calls prepareAutoStop and spawns as today when autoStop is absent', async () => {
    const deps = makeDeps()
    const { runner, state } = makeAutoStopRunner()
    const STEP = step.define('brainstorm', { agent: runner, mode: 'interactive' })

    await workflow('test', async (run) => {
      await run(STEP)
    }).execute(deps)

    expect(state.prepareCalls).toBe(0)
    expect(deps.host.interactiveSpawns[0]?.autoStop).toBeUndefined()
    expect(deps.host.interactiveSpawns[0]?.onCleanup).toBeUndefined()
  })
})
