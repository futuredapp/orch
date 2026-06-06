// MIGRATED → tests-new/unit/core/runner-addressing.test.ts (parent U10) — relocated verbatim (import paths only); kept skipped on disk (D2).
// U1 — the executor threads the run-time-derived step key, the resolved run
// state dir, and orch's own pid into the runner's `ctx.env` at spawn, on BOTH
// the autonomous and interactive paths, identically. These addressing values
// are the foundation for per-instance / per-run control-file resolution
// (U3/U5). Real runners receive the same env but their argv is unaffected.
//
// The assertions read `ctx.env` as seen by `buildCommand` — NOT the closure —
// because that is the seam the fake's entry process will resolve its control
// path from.

import { describe, expect, it } from 'bun:test'
import { runWorkflow } from '../../../src/core/run-workflow.ts'
import { step } from '../../../src/core/step.ts'
import { type WorkflowDeps, workflow } from '../../../src/core/workflow.ts'
import { claude } from '../../../src/runners/claude/index.ts'
import { defineRunner, type Runner, type RunnerContext } from '../../../src/runners/index.ts'
import {
  ORCH_PARENT_PID_ENV,
  ORCH_RUN_STATE_DIR_ENV,
  ORCH_STEP_KEY_ENV,
} from '../../../src/runners/scripted-fake/index.ts'
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

const RUN_ID = 'r-2026-06-01-090000-aa' as RunId
const BASE_PATH = '/runs'

function makeDeps(extras: Partial<WorkflowDeps> = {}): WorkflowDeps {
  const fs = new FakeFsService()
  return {
    fsService: fs,
    gitService: new FakeGitService(),
    processService: new FakeProcessService(),
    clock: new FakeClock(1000),
    stateStore: new FileStateStore({ fs, basePath: path(BASE_PATH) }),
    runId: RUN_ID,
    cwd: path('/workspace'),
    host: createFakeHost(),
    promptService: new FakePromptService(),
    interactivity: 'interactive' as const,
    ...extras,
  }
}

interface CapturingRunner {
  readonly runner: Runner
  readonly contexts: RunnerContext[]
}

// A stub Runner whose `buildCommand` records every ctx it receives and emits an
// immediate turn-complete so the autonomous path drives to a clean finish.
function capturingRunner(deps: WorkflowDeps, name: string): CapturingRunner {
  const argv = [`:${name}:`] as const
  const terminal = JSON.stringify({ kind: 'terminal', type: 'turn-complete', data: 'ok' })
  for (let i = 0; i < 40; i++) {
    ;(deps.processService as FakeProcessService)
      .when(argv)
      .respondWith({ stdout: [terminal], exitCode: 0 })
  }
  const contexts: RunnerContext[] = []
  const runner = defineRunner({
    name,
    supports: { interactive: true, structuredOutput: false },
    buildCommand(ctx: RunnerContext) {
      contexts.push(ctx)
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
  return { runner, contexts }
}

describe.skip('U1 — executor threads addressing values into ctx.env (autonomous path)', () => {
  it('exposes the derived key, run state dir, and parent pid to buildCommand', async () => {
    const deps = makeDeps()
    const cap = capturingRunner(deps, 'r1')
    const PLAN = step.define('plan', { agent: cap.runner, prompt: 'x' })

    await workflow('wf', async (run) => {
      await run(PLAN)
    }).execute(deps)

    expect(cap.contexts).toHaveLength(1)
    const env = cap.contexts[0]?.env
    expect(env?.[ORCH_STEP_KEY_ENV]).toBe('plan')
    expect(env?.[ORCH_RUN_STATE_DIR_ENV]).toBe(`${BASE_PATH}/${RUN_ID}`)
    expect(env?.[ORCH_PARENT_PID_ENV]).toBe(String(process.pid))
  })

  it('surfaces the flat `as:` label as the step key (bypassing sub-folding)', async () => {
    const deps = makeDeps()
    const cap = capturingRunner(deps, 'r1')
    const PLAN = step.define('plan', { agent: cap.runner, prompt: 'x' })

    await workflow('wf', async (run) => {
      await run(PLAN, { as: 'aliased' })
    }).execute(deps)

    expect(cap.contexts[0]?.env[ORCH_STEP_KEY_ENV]).toBe('aliased')
  })

  it('surfaces the sub-path-folded key for a step inside a subworkflow', async () => {
    const deps = makeDeps()
    const cap = capturingRunner(deps, 'r1')
    const PLAN = step.define('plan', { agent: cap.runner, prompt: 'x' })

    const sub = workflow('inner', async (run) => {
      await run(PLAN)
    })
    await workflow('outer', async () => {
      await runWorkflow(sub, {})
    }).execute(deps)

    expect(cap.contexts[0]?.env[ORCH_STEP_KEY_ENV]).toBe('inner>plan')
  })

  it('surfaces the vars-hash suffix for a vars-bearing step', async () => {
    const deps = makeDeps()
    const cap = capturingRunner(deps, 'r1')
    const GREET = step.define('greet', { agent: cap.runner, prompt: 'hi {{name}}' })

    await workflow('wf', async (run) => {
      await run(GREET, { vars: { name: 'sam' } })
    }).execute(deps)

    expect(cap.contexts[0]?.env[ORCH_STEP_KEY_ENV]).toMatch(/^greet:vars-[0-9a-f]+$/)
  })
})

describe.skip('U1 — executor threads addressing values into ctx.env (interactive path)', () => {
  it('exposes the same addressing values, identical in shape to the autonomous path', async () => {
    const deps = makeDeps({ host: createFakeHost({ mode: 'two-pane' }) })
    const cap = capturingRunner(deps, 'r1')
    const CHAT = step.define('chat', { agent: cap.runner, prompt: 'x', mode: 'interactive' })

    await workflow('wf', async (run) => {
      await run(CHAT)
    }).execute(deps)

    expect(cap.contexts).toHaveLength(1)
    const env = cap.contexts[0]?.env
    expect(env?.[ORCH_STEP_KEY_ENV]).toBe('chat')
    expect(env?.[ORCH_RUN_STATE_DIR_ENV]).toBe(`${BASE_PATH}/${RUN_ID}`)
    expect(env?.[ORCH_PARENT_PID_ENV]).toBe(String(process.pid))
  })
})

describe.skip('U1 — real runners ignore the addressing env (argv unchanged)', () => {
  it('claude builds identical argv with and without the addressing env present', async () => {
    const runner = claude()
    const base: RunnerContext = {
      cwd: path('/workspace'),
      env: {},
      prompt: 'hello',
      extraArgs: [],
    }
    const withAddressing: RunnerContext = {
      ...base,
      env: {
        [ORCH_STEP_KEY_ENV]: 'plan',
        [ORCH_RUN_STATE_DIR_ENV]: `${BASE_PATH}/${RUN_ID}`,
        [ORCH_PARENT_PID_ENV]: String(process.pid),
      },
    }

    const plain = await runner.buildCommand(base)
    const addressed = await runner.buildCommand(withAddressing)

    expect(addressed.argv).toEqual(plain.argv)
  })
})
