// U5 — `runWorkflow` primitive. Behavioral coverage for the seven
// acceptance scenarios AE1-AE7 and the depth / host-error edge cases.
//
// Uses the silent-runner pattern from other executor tests: a stub Runner
// that emits `turn-complete` immediately, paired with a `step.define` whose
// `agent` is the stub, so the workflow body can run real steps without
// touching a real CLI.

import { describe, expect, it } from 'bun:test'
import { createFakeHost } from '@orch/test/fake-host.ts'
import { SubworkflowDepthError } from '../../../src/core/errors.ts'
import { parallel } from '../../../src/core/parallel.ts'
import { runWorkflow } from '../../../src/core/run-workflow.ts'
import { step } from '../../../src/core/step.ts'
import {
  type StepLifecycleEvent,
  type WorkflowArgs,
  type WorkflowDeps,
  workflow,
} from '../../../src/core/workflow.ts'
import {
  type JsonObject,
  type LogCategory,
  type RawSink,
  type SessionLogger,
  type StepSpan,
  stepSpanId,
} from '../../../src/observability/index.ts'
import { defineRunner, type Runner, type RunnerContext } from '../../../src/runners/index.ts'
import {
  FakeClock,
  FakeFsService,
  FakeGitService,
  FakeProcessService,
  path,
} from '../../../src/services/index.ts'
import { FakePromptService } from '../../../src/services/prompt/index.ts'
import { FileStateStore, type RunId } from '../../../src/state/index.ts'

const rid = (s: string): RunId => s as RunId

class RecordingLifecycleLogger implements SessionLogger {
  readonly debug = false
  readonly logsDir = null
  readonly records: Array<{ readonly category: LogCategory; readonly record: JsonObject }> = []

  constructor(readonly runId: RunId) {}

  append(category: LogCategory, record: JsonObject): Promise<void> {
    this.records.push({ category, record })
    return Promise.resolve()
  }

  forStep(stepName: import('../../../src/core/types.ts').StepName): StepSpan {
    return {
      stepName,
      stepSpanId: stepSpanId(`span-${String(stepName)}`),
      append: (category: LogCategory, record: JsonObject): Promise<void> =>
        this.append(category, record),
    }
  }

  writeFile(_relPath: string, _body: string): Promise<void> {
    return Promise.resolve()
  }

  rawSink(_relPath: string): null {
    return null
  }

  streamSink(_relPath: string): RawSink {
    return {
      write: (_chunk: Uint8Array | string): Promise<void> => Promise.resolve(),
      close: (): Promise<void> => Promise.resolve(),
    }
  }

  close(): Promise<void> {
    return Promise.resolve()
  }
}

function makeDeps(extras: Partial<WorkflowDeps> = {}): WorkflowDeps {
  const fs = new FakeFsService()
  return {
    fsService: fs,
    gitService: new FakeGitService(),
    processService: new FakeProcessService(),
    clock: new FakeClock(1000),
    stateStore: new FileStateStore({ fs, basePath: path('/runs') }),
    runId: rid('r-2026-05-28-110000-aa'),
    cwd: path('/workspace'),
    host: createFakeHost(),
    promptService: new FakePromptService(),
    interactivity: 'interactive' as const,
    ...extras,
  }
}

function silentRunner(deps: WorkflowDeps, name: string): Runner {
  const argv = [`:${name}:`] as const
  const terminal = JSON.stringify({ kind: 'terminal', type: 'turn-complete', data: 'ok' })
  for (let i = 0; i < 40; i++) {
    ;(deps.processService as FakeProcessService)
      .when(argv)
      .respondWith({ stdout: [terminal], exitCode: 0 })
  }
  return defineRunner({
    name,
    supports: { interactive: false, structuredOutput: false },
    buildCommand(ctx: RunnerContext) {
      return { argv: [...argv], env: ctx.env }
    },
    parseEvents(line: string) {
      if (line.trim() === '') return null
      return JSON.parse(line)
    },
    extractStructuredOutput() {
      return 'ok'
    },
    toTranscriptLines() {
      return []
    },
  })
}

function recordedLifecycleEvents(deps: WorkflowDeps): StepLifecycleEvent[] {
  const host = deps.host as ReturnType<typeof createFakeHost>
  return host.recorded
    .filter((r): r is { kind: 'lifecycle'; event: StepLifecycleEvent } => r.kind === 'lifecycle')
    .map((r) => r.event)
}

describe('runWorkflow — outside-scope guard (R2)', () => {
  it('throws when called outside any active workflow execution', async () => {
    const sub = workflow('sub', async () => {})
    await expect(runWorkflow(sub, {})).rejects.toThrow(
      /runWorkflow\(\) called outside an active workflow execution/,
    )
  })
})

describe('runWorkflow — sub-frame and lifecycle events (R7, R8, R14, R15)', () => {
  it('emits subworkflow:enter before sub steps, subworkflow:exit after, both with depth 1', async () => {
    const deps = makeDeps()
    const PLAN = step.define('plan', { agent: silentRunner(deps, 'r1'), prompt: 'x' })

    const sub = workflow('simple-feature', async (run) => {
      await run(PLAN)
    })
    const parent = workflow('test', async () => {
      await runWorkflow(sub, {})
    })

    await parent.execute(deps)

    const events = recordedLifecycleEvents(deps)
    const types = events.map((e) => e.type)
    expect(types).toEqual([
      'subworkflow:enter',
      'step:start',
      'step:complete',
      'subworkflow:exit',
      'run:ended',
    ])
    const enter = events.find((e) => e.type === 'subworkflow:enter')
    expect(enter).toMatchObject({ name: 'simple-feature', depth: 1 })
    const exit = events.find((e) => e.type === 'subworkflow:exit')
    expect(exit).toMatchObject({ name: 'simple-feature', depth: 1, outcome: 'completed' })
  })

  it('nested runWorkflow reports depth 2 on its enter event', async () => {
    const deps = makeDeps()

    const inner = workflow('inner', async () => {})
    const outer = workflow('outer', async () => {
      await runWorkflow(inner, {})
    })
    const parent = workflow('test', async () => {
      await runWorkflow(outer, {})
    })

    await parent.execute(deps)

    const enters = recordedLifecycleEvents(deps).filter((e) => e.type === 'subworkflow:enter')
    expect(enters.map((e) => (e as { name: string; depth: number }).name)).toEqual([
      'outer',
      'inner',
    ])
    expect(enters.map((e) => (e as { depth: number }).depth)).toEqual([1, 2])
  })
})

describe('runWorkflow — error propagation (R10, AE1)', () => {
  it("sub error propagates as a 'failed' parent classification and emits subworkflow:exit with outcome failed", async () => {
    const deps = makeDeps()

    const sub = workflow('sub', async () => {
      throw new Error('boom')
    })
    const parent = workflow('test', async () => {
      await runWorkflow(sub, {})
    })

    await expect(parent.execute(deps)).rejects.toThrow(/boom/)

    const exit = recordedLifecycleEvents(deps).find((e) => e.type === 'subworkflow:exit')
    expect(exit).toMatchObject({ outcome: 'failed', name: 'sub' })
  })
})

describe('runWorkflow — depth guard (R21)', () => {
  it('throws SubworkflowDepthError at the bound (default 8)', async () => {
    const deps = makeDeps()

    // Build a chain that nests 9 levels deep. The 9th would push depth = 9 > 8.
    const leaf = workflow('lvl-9', async () => {})
    const lvl = (n: number, child: ReturnType<typeof workflow>) =>
      workflow(`lvl-${n}`, async () => {
        await runWorkflow(child, {})
      })
    let current = leaf
    for (let n = 8; n >= 1; n--) current = lvl(n, current)
    const parent = workflow('test', async () => {
      await runWorkflow(current, {})
    })

    await expect(parent.execute(deps)).rejects.toThrow(SubworkflowDepthError)
    const state = await deps.stateStore.loadRun(deps.runId)
    expect(state?.status).toBe('crashed')
  })

  it('respects a per-execution maxSubworkflowDepth override', async () => {
    const deps = makeDeps({ maxSubworkflowDepth: 1 })

    const inner = workflow('inner', async () => {})
    const outer = workflow('outer', async () => {
      await runWorkflow(inner, {})
    })
    const parent = workflow('test', async () => {
      await runWorkflow(outer, {})
    })

    await expect(parent.execute(deps)).rejects.toThrow(/runWorkflow depth 2 exceeds max 1/)
  })
})

describe('runWorkflow — typed args (R5, AE5)', () => {
  it('passes the typed args object into the sub body', async () => {
    interface ShipArgs extends WorkflowArgs {
      readonly prompt: string
      readonly slug: string
    }

    const deps = makeDeps()
    let seen: ShipArgs | undefined

    const sub = workflow<ShipArgs>('ship', async (_run, args) => {
      seen = args
    })
    const parent = workflow('test', async () => {
      await runWorkflow(sub, { prompt: 'go', slug: 'feature-x' })
    })

    await parent.execute(deps)

    expect(seen).toEqual({ prompt: 'go', slug: 'feature-x' })
  })
})

describe('runWorkflow — parallel composition (AE6, R8, R13)', () => {
  it('two sibling runWorkflow calls inside a homogeneous parallel block report depth 1 and insideParallel', async () => {
    const deps = makeDeps()

    const shipA = workflow('ship-a', async () => {})
    const shipB = workflow('ship-b', async () => {})
    const parent = workflow('test', async () => {
      await parallel(['T-1', 'T-2'], async (t) => {
        if (t === 'T-1') await runWorkflow(shipA, {})
        else await runWorkflow(shipB, {})
      })
    })

    await parent.execute(deps)

    const enters = recordedLifecycleEvents(deps).filter((e) => e.type === 'subworkflow:enter')
    expect(enters).toHaveLength(2)
    for (const e of enters) {
      expect((e as { depth: number }).depth).toBe(1)
      expect((e as { insideParallel?: true }).insideParallel).toBe(true)
    }

    const exits = recordedLifecycleEvents(deps).filter((e) => e.type === 'subworkflow:exit')
    expect(exits).toHaveLength(2)
    for (const e of exits) {
      expect((e as { depth: number }).depth).toBe(1)
      expect((e as { insideParallel?: true }).insideParallel).toBe(true)
    }
  })
})

describe('runWorkflow — host enter-throw vs exit-throw asymmetry (R10)', () => {
  it('host throw on subworkflow:enter propagates, logs host-error and failed exit, and the sub body does NOT run', async () => {
    const logger = new RecordingLifecycleLogger(rid('r-2026-05-28-110000-enter'))
    const deps = makeDeps({ logger })
    const host = deps.host as ReturnType<typeof createFakeHost>
    // Wrap onLifecycleEvent: throw on enter, otherwise record normally.
    const original = host.onLifecycleEvent.bind(host)
    host.onLifecycleEvent = (event: StepLifecycleEvent): void => {
      if (event.type === 'subworkflow:enter') throw new Error('host enter boom')
      original(event)
    }

    let ranBody = false
    const sub = workflow('sub', async () => {
      ranBody = true
    })
    const parent = workflow('test', async () => {
      await runWorkflow(sub, {})
    })

    await expect(parent.execute(deps)).rejects.toThrow(/host enter boom/)
    expect(ranBody).toBe(false)

    const lifecycle = logger.records
      .filter((record) => record.category === 'lifecycle')
      .map((record) => record.record)
    expect(lifecycle).toContainEqual({
      type: 'subworkflow:enter',
      name: 'sub',
      depth: 1,
      subPath: ['sub'],
    })
    expect(lifecycle).toContainEqual({
      type: 'host-error',
      source: 'subworkflow:enter',
      name: 'sub',
      depth: 1,
      message: 'host enter boom',
    })
    expect(lifecycle).toContainEqual(
      expect.objectContaining({
        type: 'subworkflow:exit',
        name: 'sub',
        depth: 1,
        outcome: 'failed',
      }),
    )
  })

  it('host throw on subworkflow:exit is suppressed and emitted as a typed host-error event', async () => {
    const deps = makeDeps()
    const host = deps.host as ReturnType<typeof createFakeHost>
    const seen: StepLifecycleEvent[] = []
    const original = host.onLifecycleEvent.bind(host)
    host.onLifecycleEvent = (event: StepLifecycleEvent): void => {
      seen.push(event)
      if (event.type === 'subworkflow:exit') throw new Error('host exit boom')
      original(event)
    }

    const sub = workflow('sub', async () => {})
    const parent = workflow('test', async () => {
      await runWorkflow(sub, {})
    })

    // Parent must complete successfully — exit host error is suppressed.
    await parent.execute(deps)

    const hostError = seen.find((e) => e.type === 'host-error')
    expect(hostError).toMatchObject({
      type: 'host-error',
      source: 'subworkflow:exit',
      name: 'sub',
    })
    expect((hostError as { message: string }).message).toContain('host exit boom')
  })
})

describe('runWorkflow — resume collision detection (R20)', () => {
  it('does not replay the first cached sub invocation for a second same-sub call after resume', async () => {
    const deps = makeDeps({ runId: rid('r-2026-05-28-110000-ab') })
    const PLAN = step.define('plan', { agent: silentRunner(deps, 'resume-collision'), prompt: 'x' })
    let firstAttempt = true

    const sub = workflow('ship', async (run) => {
      await run(PLAN)
    })
    const parent = workflow('test', async () => {
      await runWorkflow(sub, {})
      if (firstAttempt) {
        firstAttempt = false
        throw new Error('crash after first sub')
      }
      await runWorkflow(sub, {})
    })

    await expect(parent.execute(deps)).rejects.toThrow(/crash after first sub/)

    const beforeResume = await deps.stateStore.loadRun(deps.runId)
    expect(beforeResume?.steps['ship>plan']).toBeDefined()

    await expect(parent.resume(deps)).rejects.toThrow(/same workflow was invoked twice/)

    const afterResume = await deps.stateStore.loadRun(deps.runId)
    expect(Object.keys(afterResume?.steps ?? {})).toEqual(['ship>plan'])
  })

  it('claims a same-sub key before async persistence so parallel duplicate sub calls collide', async () => {
    const deps = makeDeps({ runId: rid('r-2026-05-28-110000-ac') })
    const PLAN = step.define('plan', {
      agent: silentRunner(deps, 'parallel-collision'),
      prompt: 'x',
    })

    const sub = workflow('ship', async (run) => {
      await run(PLAN)
    })
    const parent = workflow('test', async () => {
      await parallel([1, 2], async () => {
        await runWorkflow(sub, {})
      })
    })

    await expect(parent.execute(deps)).rejects.toThrow(/parallel branch/)

    const state = await deps.stateStore.loadRun(deps.runId)
    expect(Object.keys(state?.steps ?? {})).toEqual(['ship>plan'])
  })
})
