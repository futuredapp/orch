// Group A regression — when `assemblePrompt` throws (a `{{var}}`/template
// mismatch), the step must still flow through `withStepLifecycle` so the host
// sees `step:start` → `step:failed` and the step keeps its per-step attribution
// (steps-view / failure panes / cmux pills). `assemblePrompt` is hoisted ahead
// of the lifecycle envelope so the assembled prompt can ride on `step:start`;
// before the fix a hoisted throw escaped *before* `withStepLifecycle` ran, so
// NEITHER terminal event fired for that step. These tests pin both the
// autonomous and interactive hoist paths.
//
// They also pin the single-assembly guarantee (CE L-1): the prompt is assembled
// once and threaded into the produce body, so the string carried on `step:start`
// is the exact string the runner receives — true by construction, not by an
// unenforced convention that two call sites stay in lockstep.

import { describe, expect, it } from 'bun:test'
import { createFakeHost, type FakeHost } from '@orch/test/fake-host.ts'
import { step } from '../../../src/core/step.ts'
import type { StepName } from '../../../src/core/types.ts'
import { type StepLifecycleEvent, type WorkflowDeps, workflow } from '../../../src/core/workflow.ts'
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
const BASE = path('/runs')

// Captures structured span records so the bloat guard (KTD2) can be asserted
// against the same records the host's failure panes never see.
class RecordingLifecycleLogger implements SessionLogger {
  readonly debug = false
  readonly logsDir = null
  readonly records: Array<{ readonly category: LogCategory; readonly record: JsonObject }> = []

  constructor(readonly runId: RunId) {}

  append(category: LogCategory, record: JsonObject): Promise<void> {
    this.records.push({ category, record })
    return Promise.resolve()
  }

  forStep(stepName: StepName): StepSpan {
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

// `extras` overrides everything except the fake host — these tests always read
// lifecycle events off that host, so it stays fixed.
function makeDeps(extras: Omit<Partial<WorkflowDeps>, 'host'> = {}): WorkflowDeps & {
  host: FakeHost
} {
  const fs = new FakeFsService()
  const host = createFakeHost()
  return {
    fsService: fs,
    gitService: new FakeGitService(),
    processService: new FakeProcessService(),
    clock: new FakeClock(1000),
    stateStore: new FileStateStore({ fs, basePath: BASE }),
    runId: rid('r-2026-06-19-100000-aa'),
    cwd: path('/workspace'),
    promptService: new FakePromptService(),
    interactivity: 'interactive' as const,
    ...extras,
    host,
  }
}

// A runner whose `buildCommand` records the prompt the runner actually receives.
// For the throw cases it is never invoked (assembly fails first); for the
// single-assembly case it proves carried prompt == runner-received prompt.
function promptCapturingRunner(
  deps: WorkflowDeps,
  name: string,
  supportsInteractive = false,
): { runner: Runner; prompts: ReadonlyArray<string> } {
  const prompts: string[] = []
  const argv = [`:${name}:`] as const
  const terminal = JSON.stringify({ kind: 'terminal', type: 'turn-complete', data: 'ok' })
  for (let i = 0; i < 10; i++) {
    ;(deps.processService as FakeProcessService)
      .when(argv)
      .respondWith({ stdout: [terminal], exitCode: 0 })
  }
  const runner = defineRunner({
    name,
    supports: { interactive: supportsInteractive, structuredOutput: false },
    buildCommand(ctx: RunnerContext) {
      prompts.push(ctx.prompt)
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
  return { runner, prompts }
}

function lifecycleEvents(host: FakeHost): StepLifecycleEvent[] {
  return host.recorded
    .filter((r): r is { kind: 'lifecycle'; event: StepLifecycleEvent } => r.kind === 'lifecycle')
    .map((r) => r.event)
}

describe('prompt-assembly failure routes through the step lifecycle (Group A)', () => {
  it('emits step:start and step:failed for an autonomous step whose prompt has an unresolved placeholder', async () => {
    const deps = makeDeps()
    const { runner, prompts } = promptCapturingRunner(deps, 'auto-fail')
    const STEP = step.define('plan', { agent: runner, prompt: 'Topic: {{topic}}' })

    const wf = workflow('test', async (run) => {
      await run(STEP)
    })

    await expect(wf.execute(deps)).rejects.toThrow(/topic/)

    const events = lifecycleEvents(deps.host)
    const types = events.map((e) => e.type)
    expect(types).toContain('step:start')
    expect(types).toContain('step:failed')

    const start = events.find((e) => e.type === 'step:start')
    expect(start).toMatchObject({ stepName: 'plan', mode: 'autonomous', runnerName: 'auto-fail' })
    // No prompt was assembled, so none is carried — and the runner never ran.
    expect(start).not.toHaveProperty('prompt')
    expect(prompts).toHaveLength(0)

    const failed = events.find((e) => e.type === 'step:failed')
    expect(failed).toMatchObject({ stepName: 'plan' })
  })

  it('emits step:start and step:failed for an interactive step whose prompt has an unresolved placeholder', async () => {
    const deps = makeDeps({
      onInteractive: async () => ({
        exitCode: 0,
        durationMs: 1,
        sessionId: '11111111-1111-1111-1111-111111111111',
      }),
    })
    const { runner, prompts } = promptCapturingRunner(deps, 'inter-fail', true)
    const STEP = step.define('brainstorm', {
      agent: runner,
      mode: 'interactive',
      prompt: 'Hello {{name}}',
    })

    const wf = workflow('test', async (run) => {
      await run(STEP)
    })

    await expect(wf.execute(deps)).rejects.toThrow(/name/)

    const events = lifecycleEvents(deps.host)
    const types = events.map((e) => e.type)
    expect(types).toContain('step:start')
    expect(types).toContain('step:failed')

    const start = events.find((e) => e.type === 'step:start')
    expect(start).toMatchObject({
      stepName: 'brainstorm',
      mode: 'interactive',
      runnerName: 'inter-fail',
    })
    expect(start).not.toHaveProperty('prompt')
    expect(prompts).toHaveLength(0)

    const failed = events.find((e) => e.type === 'step:failed')
    expect(failed).toMatchObject({ stepName: 'brainstorm' })
  })

  it('does not bloat the structured step:failed record with a prompt field on assembly failure (KTD2)', async () => {
    const logger = new RecordingLifecycleLogger(rid('r-2026-06-19-100000-bb'))
    const deps = makeDeps({ logger, runId: logger.runId })
    const { runner } = promptCapturingRunner(deps, 'rec-fail')
    const STEP = step.define('plan', { agent: runner, prompt: 'Topic: {{topic}}' })

    const wf = workflow('test', async (run) => {
      await run(STEP)
    })

    await expect(wf.execute(deps)).rejects.toThrow(/topic/)

    const lifecycle = logger.records.filter((r) => r.category === 'lifecycle').map((r) => r.record)
    const failedRecord = lifecycle.find((r) => r.type === 'step:failed')
    expect(failedRecord).toBeDefined()
    expect(failedRecord).not.toHaveProperty('prompt')
    const startRecord = lifecycle.find((r) => r.type === 'step:start')
    expect(startRecord).toBeDefined()
    expect(startRecord).not.toHaveProperty('prompt')
  })
})

describe('single-assembly guarantee — carried prompt == runner-received prompt (Group A / CE L-1)', () => {
  it('threads one assembled string so the prompt on step:start is the exact prompt the runner receives', async () => {
    const deps = makeDeps()
    const { runner, prompts } = promptCapturingRunner(deps, 'auto-ok')
    const STEP = step.define('plan', { agent: runner, prompt: 'Topic: {{topic}}' })

    const wf = workflow('test', async (run) => {
      await run(STEP, { vars: { topic: 'compounding' } })
    })

    await wf.execute(deps)

    const start = lifecycleEvents(deps.host).find((e) => e.type === 'step:start') as
      | (StepLifecycleEvent & { prompt?: string })
      | undefined
    expect(start).toBeDefined()
    expect(prompts).toEqual(['Topic: compounding'])
    // The string carried for the right-pane preamble is byte-identical to the
    // one the runner received — proven by construction now that assembly happens
    // once and is threaded into the produce body.
    expect(start?.prompt).toBe('Topic: compounding')
  })
})
