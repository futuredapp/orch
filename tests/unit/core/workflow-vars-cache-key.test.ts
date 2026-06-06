/**
 * Tests U2's cache-key fold and run-time substitution behavior:
 *
 *   - `run(STEP, { vars: { topic: 'A' } })` and `run(STEP, { vars: { topic: 'B' } })`
 *     produce DISTINCT cache entries inside the same workflow run.
 *   - `run(STEP, { vars: ... })` twice with the same vars hits the cache.
 *   - `run(STEP, { as: 'override', vars: ... })` uses `as:` verbatim (no
 *     vars-hash appended) — caller's explicit override wins.
 *   - `run(STEP, { vars: ... })` with the same `prompt:` template fed to a
 *     workflow body sees substituted prompts at the runner boundary.
 */

import { describe, expect, it } from 'bun:test'
import { createFakeHost } from '@orch/test/fake-host.ts'
import { step } from '../../../src/core/step.ts'
import { type WorkflowDeps, workflow } from '../../../src/core/workflow.ts'
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

function makeDeps(): WorkflowDeps {
  const fs = new FakeFsService()
  const processService = new FakeProcessService()
  return {
    fsService: fs,
    gitService: new FakeGitService(),
    processService,
    clock: new FakeClock(1000),
    stateStore: new FileStateStore({ fs, basePath: BASE }),
    runId: rid('r-2026-05-28-100000-aa'),
    cwd: path('/workspace'),
    host: createFakeHost(),
    promptService: new FakePromptService(),
    interactivity: 'interactive' as const,
  }
}

interface PromptCapture {
  readonly runner: Runner
  readonly prompts: ReadonlyArray<string>
}

function promptCapturingRunner(deps: WorkflowDeps, name: string): PromptCapture {
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
    supports: { interactive: false, structuredOutput: false },
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

describe('workflow run() with RunOverrides.vars — cache-key fold', () => {
  it('AE3: distinct vars produce distinct cache entries inside the same run', async () => {
    const deps = makeDeps()
    const cap = promptCapturingRunner(deps, 'pc1')
    const STEP = step.define('plan', { agent: cap.runner, prompt: 'Topic: {{topic}}' })

    const wf = workflow('test', async (run) => {
      await run(STEP, { vars: { topic: 'A' } })
      await run(STEP, { vars: { topic: 'B' } })
    })
    await wf.execute(deps)

    expect(cap.prompts).toHaveLength(2)
    expect(cap.prompts[0]).toBe('Topic: A')
    expect(cap.prompts[1]).toBe('Topic: B')

    const state = await deps.stateStore.loadRun(deps.runId)
    const keys = Object.keys(state?.steps ?? {})
    // Two distinct entries — both prefixed with the step name and a vars hash.
    expect(keys).toHaveLength(2)
    for (const k of keys) {
      expect(k.startsWith('plan:vars-')).toBe(true)
    }
    expect(keys[0]).not.toBe(keys[1])
  })

  it('same vars on a second call hit the cache', async () => {
    const deps = makeDeps()
    const cap = promptCapturingRunner(deps, 'pc2')
    const STEP = step.define('plan', { agent: cap.runner, prompt: 'Topic: {{topic}}' })

    const wf = workflow('test', async (run) => {
      await run(STEP, { vars: { topic: 'A' } })
      await run(STEP, { vars: { topic: 'A' } })
    })
    await wf.execute(deps)

    expect(cap.prompts).toHaveLength(1)
  })

  it('uses overrides.as verbatim (no vars-hash appended) when as is set', async () => {
    const deps = makeDeps()
    const cap = promptCapturingRunner(deps, 'pc3')
    const STEP = step.define('plan', { agent: cap.runner, prompt: 'Topic: {{topic}}' })

    const wf = workflow('test', async (run) => {
      await run(STEP, { as: 'override-name', vars: { topic: 'A' } })
    })
    await wf.execute(deps)

    const state = await deps.stateStore.loadRun(deps.runId)
    const keys = Object.keys(state?.steps ?? {})
    expect(keys).toEqual(['override-name'])
  })

  it('no vars → cache key unchanged from today (back-compat)', async () => {
    const deps = makeDeps()
    const cap = promptCapturingRunner(deps, 'pc4')
    const STEP = step.define('plan', { agent: cap.runner, prompt: 'static text' })

    const wf = workflow('test', async (run) => {
      await run(STEP)
      await run(STEP)
    })
    await wf.execute(deps)

    const state = await deps.stateStore.loadRun(deps.runId)
    const keys = Object.keys(state?.steps ?? {})
    expect(keys).toEqual(['plan'])
    expect(cap.prompts).toHaveLength(1)
  })

  it('empty vars object also produces the unchanged cache key', async () => {
    const deps = makeDeps()
    const cap = promptCapturingRunner(deps, 'pc5')
    const STEP = step.define('plan', { agent: cap.runner, prompt: 'static text' })

    const wf = workflow('test', async (run) => {
      await run(STEP, { vars: {} })
    })
    await wf.execute(deps)

    const state = await deps.stateStore.loadRun(deps.runId)
    const keys = Object.keys(state?.steps ?? {})
    expect(keys).toEqual(['plan'])
  })
})

describe('workflow run() with RunOverrides.vars — substitution timing', () => {
  it('substitutes the template at run() time, not at step.define time', async () => {
    const deps = makeDeps()
    const cap = promptCapturingRunner(deps, 'pc6')
    // step.define succeeds even though `{{topic}}` is unresolved.
    const STEP = step.define('plan', { agent: cap.runner, prompt: 'Topic: {{topic}}' })

    const wf = workflow('test', async (run) => {
      await run(STEP, { vars: { topic: 'late-bound' } })
    })
    await wf.execute(deps)

    expect(cap.prompts).toEqual(['Topic: late-bound'])
  })

  it('overrides.prompt bypasses substitution entirely (R10)', async () => {
    const deps = makeDeps()
    const cap = promptCapturingRunner(deps, 'pc7')
    const STEP = step.define('plan', { agent: cap.runner, prompt: 'Topic: {{topic}}' })

    const wf = workflow('test', async (run) => {
      await run(STEP, { prompt: 'totally different', vars: { topic: 'X' } })
    })
    await wf.execute(deps)

    expect(cap.prompts).toEqual(['totally different'])
  })

  it('throws missing-placeholder before runner starts when vars is empty but template has placeholders', async () => {
    const deps = makeDeps()
    const cap = promptCapturingRunner(deps, 'pc8')
    const STEP = step.define('plan', { agent: cap.runner, prompt: 'Topic: {{topic}}' })

    const wf = workflow('test', async (run) => {
      await run(STEP)
    })

    let thrown: unknown
    try {
      await wf.execute(deps)
    } catch (e) {
      thrown = e
    }

    expect(thrown).toBeDefined()
    expect((thrown as Error).message).toContain('topic')
    expect(cap.prompts).toHaveLength(0)
  })

  it('throws extra-key when caller passes vars but template has no placeholders', async () => {
    const deps = makeDeps()
    const cap = promptCapturingRunner(deps, 'pc9')
    const STEP = step.define('plan', { agent: cap.runner, prompt: 'static text' })

    const wf = workflow('test', async (run) => {
      // Strict typing also flags this at compile time (the no-vars sentinel
      // rejects any string key). We keep the runtime test to defend against
      // downstream callers that cast around the type system.
      // @ts-expect-error — `x` is not a declared key on the no-vars sentinel
      await run(STEP, { vars: { x: 'y' } })
    })

    let thrown: unknown
    try {
      await wf.execute(deps)
    } catch (e) {
      thrown = e
    }

    expect(thrown).toBeDefined()
    expect((thrown as Error).message).toContain('x')
    expect(cap.prompts).toHaveLength(0)
  })

  it('static prompt + no vars = no substitution (back-compat for shipped workflows)', async () => {
    const deps = makeDeps()
    const cap = promptCapturingRunner(deps, 'pc10')
    const STEP = step.define('plan', { agent: cap.runner, prompt: 'static text, no vars' })

    const wf = workflow('test', async (run) => {
      await run(STEP)
    })
    await wf.execute(deps)

    expect(cap.prompts).toEqual(['static text, no vars'])
  })

  it('combines substituted template with extraContext and extraPrompt', async () => {
    const deps = makeDeps()
    const cap = promptCapturingRunner(deps, 'pc11')
    const STEP = step.define('plan', { agent: cap.runner, prompt: 'Hi {{name}}' })

    const wf = workflow('test', async (run) => {
      await run(STEP, { vars: { name: 'world' }, extraPrompt: 'PS: be brief' })
    })
    await wf.execute(deps)

    expect(cap.prompts[0]).toContain('Hi world')
    expect(cap.prompts[0]).toContain('PS: be brief')
  })
})
