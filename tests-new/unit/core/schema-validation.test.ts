import { describe, expect, it } from 'bun:test'
import { z } from 'zod'
import { SchemaValidationError, schema } from '../../../src/core/schema.ts'
import { step } from '../../../src/core/step.ts'
import type { RunFn, WorkflowDeps } from '../../../src/core/workflow.ts'
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
import { check } from '../../../src/validators/index.ts'
import { createFakeHost } from '@orch/test/fake-host.ts'
import type { Equal, Expect } from '@orch/test/type-assertions.ts'

const rid = (s: string): RunId => s as RunId
const BASE = path('/runs')

function makeDeps(overrides?: {
  fs?: FakeFsService
  processService?: FakeProcessService
  clock?: FakeClock
  runId?: RunId
}): WorkflowDeps & { processService: FakeProcessService; fs: FakeFsService } {
  const fs = overrides?.fs ?? new FakeFsService()
  const processService = overrides?.processService ?? new FakeProcessService()
  const clock = overrides?.clock ?? new FakeClock(1000)
  return {
    fs,
    fsService: fs,
    gitService: new FakeGitService(),
    processService,
    clock,
    stateStore: new FileStateStore({ fs, basePath: BASE }),
    runId: overrides?.runId ?? rid('r-2026-04-12-935632-9n'),
    cwd: path('/workspace'),
    host: createFakeHost(),
    promptService: new FakePromptService(),
    interactivity: 'interactive' as const,
  }
}

// ---------------------------------------------------------------------------
// Runner that does NOT support structured output — for capability check tests
// ---------------------------------------------------------------------------

function noSchemaRunner(fps: FakeProcessService): Runner {
  const argv = [':no-schema:'] as const
  fps.when(argv).respondWith({
    stdout: [JSON.stringify({ kind: 'terminal', type: 'turn-complete', data: 'ok' })],
    exitCode: 0,
  })
  return defineRunner({
    name: 'no-schema-runner',
    supports: { interactive: false, structuredOutput: false },
    buildCommand(ctx: RunnerContext) {
      return { argv, env: ctx.env }
    },
    parseEvents(line: string) {
      if (line.trim() === '') return null
      return JSON.parse(line) as import('../../../src/runners/types.ts').RunnerEvent
    },
    extractStructuredOutput() {
      return undefined
    },
    toTranscriptLines() {
      return []
    },
  })
}

describe('executor capability check', () => {
  it('step with returns on a runner that does not support structured output throws at step start', async () => {
    const deps = makeDeps()
    const runner = noSchemaRunner(deps.processService)
    const STEP = step.define('typed', {
      agent: runner,
      returns: schema(z.object({ a: z.string() })),
    })

    const wf = workflow('test', async (run) => {
      await run(STEP)
    })

    let caught: unknown
    try {
      await wf.execute(deps)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain('no-schema-runner')
    expect((caught as Error).message).toContain('does not support structured output')
    expect((caught as Error).message).toContain('typed')
  })

  it('step with returns on a capable runner does not throw', async () => {
    const deps = makeDeps()
    const fr = new FakeRunner(deps.processService)
    fr.script({ structuredOutput: { a: 'hello' } })
    const STEP = step.define('typed', {
      agent: fr,
      returns: schema(z.object({ a: z.string() })),
    })

    let result: unknown
    const wf = workflow('test', async (run) => {
      result = await run(STEP)
    })
    await wf.execute(deps)

    expect(result).toEqual({ a: 'hello' })
  })

  it('step without returns does not Zod-validate and returns raw value', async () => {
    const deps = makeDeps()
    const fr = new FakeRunner(deps.processService)
    fr.script({ structuredOutput: 'raw-string' })
    const STEP = step.define('plain', { agent: fr })

    let result: unknown
    const wf = workflow('test', async (run) => {
      result = await run(STEP)
    })
    await wf.execute(deps)

    expect(result).toBe('raw-string')
  })
})

describe('executor Zod validation', () => {
  it('valid structured output is Zod-parsed and returned', async () => {
    const deps = makeDeps()
    const fr = new FakeRunner(deps.processService)
    fr.script({ structuredOutput: { name: 'Alice', age: 30 } })
    const STEP = step.define('typed', {
      agent: fr,
      returns: schema(z.object({ name: z.string(), age: z.number() })),
    })

    let result: unknown
    const wf = workflow('test', async (run) => {
      result = await run(STEP)
    })
    await wf.execute(deps)

    expect(result).toEqual({ name: 'Alice', age: 30 })
  })

  it('invalid structured output throws SchemaValidationError with Zod path', async () => {
    const deps = makeDeps()
    const fr = new FakeRunner(deps.processService)
    fr.script({ structuredOutput: { name: 123, age: 'wrong' } })
    const STEP = step.define('typed', {
      agent: fr,
      returns: schema(z.object({ name: z.string(), age: z.number() })),
    })

    const wf = workflow('test', async (run) => {
      await run(STEP)
    })

    let caught: unknown
    try {
      await wf.execute(deps)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(SchemaValidationError)
    const sve = caught as SchemaValidationError
    expect(sve.message).toContain('typed')
    expect(sve.message).toContain('name')
    expect(sve.message).toContain('age')
  })

  it('undefined structured_output with schema present throws clear error before Zod parse', async () => {
    const deps = makeDeps()
    const fr = new FakeRunner(deps.processService)
    // FakeRunner returns (finalEvent as { data?: unknown }).data — if data is
    // undefined, extractStructuredOutput returns undefined.
    fr.script({ structuredOutput: undefined })
    const STEP = step.define('typed', {
      agent: fr,
      returns: schema(z.object({ x: z.string() })),
    })

    const wf = workflow('test', async (run) => {
      await run(STEP)
    })

    let caught: unknown
    try {
      await wf.execute(deps)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(Error)
    expect(caught).not.toBeInstanceOf(SchemaValidationError)
    expect((caught as Error).message).toContain('no structured_output')
    expect((caught as Error).message).toContain('--json-schema')
  })

  it('null structured_output with schema present reaches Zod parse and produces actionable error', async () => {
    const deps = makeDeps()
    const fr = new FakeRunner(deps.processService)
    fr.script({ structuredOutput: null })
    const STEP = step.define('typed', {
      agent: fr,
      returns: schema(z.object({ x: z.string() })),
    })

    const wf = workflow('test', async (run) => {
      await run(STEP)
    })

    let caught: unknown
    try {
      await wf.execute(deps)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(SchemaValidationError)
    expect((caught as SchemaValidationError).message).toContain('typed')
  })

  it('z.transform schema applies transform after CLI extraction', async () => {
    const deps = makeDeps()
    const fr = new FakeRunner(deps.processService)
    fr.script({ structuredOutput: { count: '42' } })
    const STEP = step.define('transform', {
      agent: fr,
      returns: schema(z.object({ count: z.string().transform(Number) })),
    })

    let result: unknown
    const wf = workflow('test', async (run) => {
      result = await run(STEP)
    })
    await wf.execute(deps)

    expect(result).toEqual({ count: 42 })
  })

  it('validators receive post-transform value in ctx.value', async () => {
    const deps = makeDeps()
    const fr = new FakeRunner(deps.processService)
    fr.script({ structuredOutput: { count: '7' } })

    let capturedValue: unknown
    const spy = check((ctx) => {
      capturedValue = ctx.value
      return true
    })

    const STEP = step.define('transform-val', {
      agent: fr,
      returns: schema(z.object({ count: z.string().transform(Number) })),
      validate: spy,
    })

    const wf = workflow('test', async (run) => {
      await run(STEP)
    })
    await wf.execute(deps)

    expect(capturedValue).toEqual({ count: 7 })
  })
})

describe('cache-hit re-validation', () => {
  it('re-validates cached value when schema is present', async () => {
    const sharedRunId = rid('r-2026-04-12-408036-se')
    const fs = new FakeFsService()

    // First run: step succeeds with valid data, gets cached
    const fps1 = new FakeProcessService()
    const deps1 = makeDeps({ fs, processService: fps1, runId: sharedRunId })
    const fr1 = new FakeRunner(fps1)
    fr1.script({ structuredOutput: { name: 'Alice' } })
    const STEP1 = step.define('cached', {
      agent: fr1,
      returns: schema(z.object({ name: z.string() })),
    })

    const wf1 = workflow('test', async (run) => {
      await run(STEP1)
    })
    await wf1.execute(deps1)

    // Second run: same step name but stricter schema — cached value doesn't match
    const fps2 = new FakeProcessService()
    const deps2 = makeDeps({ fs, processService: fps2, runId: sharedRunId })
    const fr2 = new FakeRunner(fps2)
    fr2.script({ structuredOutput: { name: 'Bob', age: 25 } })
    const STEP2 = step.define('cached', {
      agent: fr2,
      returns: schema(z.object({ name: z.string(), age: z.number() })),
    })

    const wf2 = workflow('test', async (run) => {
      await run(STEP2)
    })

    let caught: unknown
    try {
      await wf2.execute(deps2)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(SchemaValidationError)
    expect((caught as SchemaValidationError).message).toContain('cached')
  })
})

// ---------------------------------------------------------------------------
// Compile-time type assertions — RunFn generic
// ---------------------------------------------------------------------------

const _fps = new FakeProcessService()
const _fakeRunner = new FakeRunner(_fps)

const SCHEMA_STEP = step.define('s', {
  agent: _fakeRunner,
  returns: schema(z.object({ a: z.string() })),
})

const PLAIN_STEP = step.define('p', { agent: _fakeRunner })

// These type-level assertions verify that RunFn's generic flows through:
type _RunTyped = Expect<Equal<ReturnType<typeof _checkTypedRun>, Promise<{ a: string }>>>
type _RunPlain = Expect<Equal<ReturnType<typeof _checkPlainRun>, Promise<unknown>>>

function _checkTypedRun(run: RunFn) {
  return run(SCHEMA_STEP)
}
function _checkPlainRun(run: RunFn) {
  return run(PLAIN_STEP)
}

describe('RunFn generic type inference', () => {
  it('end-to-end: define step with schema, script FakeRunner, run, destructure typed result', async () => {
    const deps = makeDeps()
    const fr = new FakeRunner(deps.processService)
    fr.script({ structuredOutput: { title: 'Report', items: ['a', 'b'], count: 2 } })
    const STEP = step.define('research', {
      agent: fr,
      returns: schema(
        z.object({
          title: z.string(),
          items: z.array(z.string()),
          count: z.number(),
        }),
      ),
    })

    let title: string | undefined
    let items: string[] | undefined
    let count: number | undefined
    const wf = workflow('test', async (run) => {
      const result = await run(STEP)
      // These destructurings compile without annotations — proves type flows.
      title = result.title
      items = result.items
      count = result.count
    })
    await wf.execute(deps)

    expect(title).toBe('Report')
    expect(items).toEqual(['a', 'b'])
    expect(count).toBe(2)
  })
})
