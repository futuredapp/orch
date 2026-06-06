import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createFakeHost } from '@orch/test/fake-host.ts'
import { z } from 'zod'
import { SchemaValidationError, schema } from '../../../../src/core/schema.ts'
import { step } from '../../../../src/core/step.ts'
import type { WorkflowDeps } from '../../../../src/core/workflow.ts'
import { StepError, workflow } from '../../../../src/core/workflow.ts'
import { claude, FakeRunner } from '../../../../src/runners/index.ts'
import {
  FakeClock,
  FakeFsService,
  FakeGitService,
  FakeProcessService,
  path,
} from '../../../../src/services/index.ts'
import { FakePromptService } from '../../../../src/services/prompt/index.ts'
import { FileStateStore, type RunId } from '../../../../src/state/index.ts'
import { check } from '../../../../src/validators/index.ts'

const rid = (s: string): RunId => s as RunId
const BASE = path('/runs')

function loadFixtureLines(name: string): string[] {
  const filePath = resolve(import.meta.dir, '../../../_support/fixtures/claude', name)
  return readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter((l) => l.trim() !== '')
}

function makeDeps(overrides?: {
  fs?: FakeFsService
  processService?: FakeProcessService
  runId?: RunId
}): WorkflowDeps & { processService: FakeProcessService; clock: FakeClock } {
  const fs = overrides?.fs ?? new FakeFsService()
  const processService = overrides?.processService ?? new FakeProcessService()
  const clock = new FakeClock(1000)
  return {
    fsService: fs,
    gitService: new FakeGitService(),
    processService,
    clock,
    stateStore: new FileStateStore({ fs, basePath: BASE }),
    runId: overrides?.runId ?? rid('r-2026-04-12-585828-kn'),
    cwd: path('/workspace'),
    host: createFakeHost(),
    promptService: new FakePromptService(),
    interactivity: 'interactive' as const,
  }
}

const researchSchema = z.object({
  title: z.string(),
  items: z.array(z.string()),
  count: z.number(),
})

describe('ClaudeRunner structured output — mocked integration', () => {
  it('full round-trip: schema step through ClaudeRunner with structured-output-success fixture', async () => {
    const deps = makeDeps()
    const runner = claude()
    const ctx = {
      cwd: path('/workspace'),
      env: {},
      prompt: 'Analyze risks',
      extraArgs: [] as string[],
      schema: { jsonSchema: schema(researchSchema).jsonSchema },
    }
    const cmd = await runner.buildCommand(ctx)

    const fixtureLines = loadFixtureLines('structured-output-success.jsonl')
    deps.processService.when(cmd.argv).respondWith({ stdout: fixtureLines, exitCode: 0 })

    const STEP = step.define('research', {
      agent: runner,
      prompt: 'Analyze risks',
      returns: schema(researchSchema),
    })

    let result: unknown
    const wf = workflow('test', async (run) => {
      result = await run(STEP)
    })
    await wf.execute(deps)

    expect(result).toEqual({ title: 'Analysis', items: ['risk-a', 'risk-b'], count: 2 })
  })

  it('schema validation failure with structured-output-invalid fixture throws SchemaValidationError', async () => {
    const deps = makeDeps({ runId: rid('r-2026-04-12-363448-1r') })
    const runner = claude()
    const ctx = {
      cwd: path('/workspace'),
      env: {},
      prompt: 'Analyze risks',
      extraArgs: [] as string[],
      schema: { jsonSchema: schema(researchSchema).jsonSchema },
    }
    const cmd = await runner.buildCommand(ctx)

    const fixtureLines = loadFixtureLines('structured-output-invalid.jsonl')
    deps.processService.when(cmd.argv).respondWith({ stdout: fixtureLines, exitCode: 0 })

    const STEP = step.define('research', {
      agent: runner,
      prompt: 'Analyze risks',
      returns: schema(researchSchema),
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
    expect(sve.message).toContain('research')
  })

  it('error_max_structured_output_retries fixture routes to StepError', async () => {
    const deps = makeDeps({ runId: rid('r-2026-04-12-141064-jv') })
    const runner = claude()
    const ctx = {
      cwd: path('/workspace'),
      env: {},
      prompt: 'Analyze risks',
      extraArgs: [] as string[],
      schema: { jsonSchema: schema(researchSchema).jsonSchema },
    }
    const cmd = await runner.buildCommand(ctx)

    const fixtureLines = loadFixtureLines('structured-output-retries-exhausted.jsonl')
    deps.processService.when(cmd.argv).respondWith({ stdout: fixtureLines, exitCode: 1 })

    const STEP = step.define('research', {
      agent: runner,
      prompt: 'Analyze risks',
      returns: schema(researchSchema),
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

    expect(caught).toBeInstanceOf(StepError)
    expect((caught as StepError).message).toContain('Max structured output retries')
  })

  it('memoization: second run returns cached value without re-running', async () => {
    const deps = makeDeps({ runId: rid('r-2026-04-12-918684-0z') })
    const fr = new FakeRunner(deps.processService)
    fr.script({ structuredOutput: { title: 'Cached', items: [], count: 0 } })
    const STEP = step.define('memo', {
      agent: fr,
      returns: schema(researchSchema),
    })

    let first: unknown
    let second: unknown
    const wf = workflow('test', async (run) => {
      first = await run(STEP)
      second = await run(STEP)
    })
    await wf.execute(deps)

    expect(first).toEqual({ title: 'Cached', items: [], count: 0 })
    expect(second).toEqual({ title: 'Cached', items: [], count: 0 })
    expect(fr.invocationCount).toBe(1)
  })

  it('schema step with validators: structured output available as ctx.value in check()', async () => {
    const deps = makeDeps({ runId: rid('r-2026-04-12-696304-i3') })
    const fr = new FakeRunner(deps.processService)
    fr.script({ structuredOutput: { title: 'Report', items: ['x'], count: 1 } })

    let capturedValue: unknown
    const spy = check((ctx) => {
      capturedValue = ctx.value
      return true
    })

    const STEP = step.define('validated', {
      agent: fr,
      returns: schema(researchSchema),
      validate: spy,
    })

    const wf = workflow('test', async (run) => {
      await run(STEP)
    })
    await wf.execute(deps)

    expect(capturedValue).toEqual({ title: 'Report', items: ['x'], count: 1 })
  })

  it('--bare and --json-schema coexist: structured_output present in result envelope', async () => {
    const deps = makeDeps({ runId: rid('r-2026-04-12-473920-07') })
    const runner = claude({ bare: true })

    const s = schema(researchSchema)
    const ctx = {
      cwd: path('/workspace'),
      env: {},
      prompt: 'Analyze risks',
      extraArgs: [] as string[],
      schema: { jsonSchema: s.jsonSchema },
    }
    const cmd = await runner.buildCommand(ctx)

    // Verify both flags are in argv
    expect(cmd.argv).toContain('--bare')
    expect(cmd.argv).toContain('--json-schema')

    // Fixture has structured_output populated — verify round-trip works
    const fixtureLines = loadFixtureLines('structured-output-success.jsonl')
    deps.processService.when(cmd.argv).respondWith({ stdout: fixtureLines, exitCode: 0 })

    const STEP = step.define('bare-schema', {
      agent: runner,
      prompt: 'Analyze risks',
      returns: s,
    })

    let result: unknown
    const wf = workflow('test', async (run) => {
      result = await run(STEP)
    })
    await wf.execute(deps)

    expect(result).toEqual({ title: 'Analysis', items: ['risk-a', 'risk-b'], count: 2 })
  })
})
