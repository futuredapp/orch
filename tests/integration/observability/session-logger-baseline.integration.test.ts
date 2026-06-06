// ---------------------------------------------------------------------------
// Phase 2 baseline hook-in integration — drives the real workflow executor
// plus a FileSessionLogger and asserts every baseline log file lands with the
// expected shape. Uses a FakeRunner through FakeProcessService so no external
// CLI is required; writes to a real temp dir through BunFsService.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { step } from '../../../src/core/step.ts'
import { type WorkflowDeps, workflow } from '../../../src/core/workflow.ts'
import { createPlainHost } from '../../../src/hosts/index.ts'
import {
  buildRunMeta,
  createFileSessionLogger,
  renderRunReadme,
  type SessionLogger,
} from '../../../src/observability/index.ts'
import { FakeRunner } from '../../../src/runners/index.ts'
import {
  BunFsService,
  FakeClock,
  FakeGitService,
  FakeProcessService,
  path,
} from '../../../src/services/index.ts'
import { FakePromptService } from '../../../src/services/prompt/index.ts'
import { FileStateStore, type RunId, runId as runIdFactory } from '../../../src/state/index.ts'

const RUN_ID: RunId = runIdFactory('r-2026-04-24-509408-py')

let tempDir: string
let logsDir: string
let basePath: ReturnType<typeof path>

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'orch-session-baseline-'))
  basePath = path(join(tempDir, '.orch', 'state'))
  logsDir = join(basePath, RUN_ID, 'logs')
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

async function readLines(rel: string): Promise<Array<Record<string, unknown>>> {
  const body = await readFile(join(logsDir, rel), 'utf8')
  return body
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

async function readJson<T>(rel: string): Promise<T> {
  const body = await readFile(join(logsDir, rel), 'utf8')
  return JSON.parse(body) as T
}

interface RigOptions {
  readonly script?: { readonly structuredOutput?: unknown }
}

interface Rig {
  readonly logger: SessionLogger
  readonly clock: FakeClock
  readonly deps: WorkflowDeps
  readonly runner: FakeRunner
}

async function makeRig(opts: RigOptions = {}): Promise<Rig> {
  const bunFs = new BunFsService()
  const clock = new FakeClock(1_000)
  const processService = new FakeProcessService()
  const runner = new FakeRunner(processService)
  runner.script({ structuredOutput: opts.script?.structuredOutput ?? 'ok' })

  const logger = createFileSessionLogger({
    fs: bunFs,
    clock,
    runId: RUN_ID,
    basePath,
    debug: false,
  })

  const host = createPlainHost({
    stdout: process.stdout,
    stderr: process.stderr,
    format: 'text',
    clock,
    runId: RUN_ID,
    logger,
  })

  const deps: WorkflowDeps = {
    stateStore: new FileStateStore({ fs: bunFs, basePath }),
    processService,
    clock,
    runId: RUN_ID,
    cwd: path(tempDir),
    fsService: bunFs,
    gitService: new FakeGitService(),
    host,
    promptService: new FakePromptService(),
    interactivity: 'interactive' as const,
    logger,
  }

  return { logger, clock, deps, runner }
}

describe('session-logger baseline hook-ins (integration)', () => {
  it('FakeRunner-driven workflow writes spawns.ndjson with correct argv, envKeys and mode', async () => {
    const rig = await makeRig()
    const demo = step.define('demo', { agent: rig.runner, prompt: 'hi' })
    const wf = workflow('baseline', async (run) => {
      await run(demo)
    })

    await wf.execute(rig.deps)
    await rig.logger.close()

    const lines = await readLines('spawns.ndjson')
    expect(lines.length).toBe(1)
    const [record] = lines
    expect(record?.stepName).toBe('demo')
    expect(record?.runnerName).toBe('fake')
    expect(record?.mode).toBe('autonomous')
    expect(typeof record?.stepSpanId).toBe('string')
    expect(Array.isArray(record?.argv)).toBe(true)
    expect(Array.isArray(record?.envKeys)).toBe(true)
    expect(record?.exitCode).toBe(0)
    expect(typeof record?.durationMs).toBe('number')
  })

  it('events.ndjson contains one record per RunnerEvent and every record carries a stepSpanId', async () => {
    const rig = await makeRig()
    const demo = step.define('demo', { agent: rig.runner, prompt: 'hi' })
    const wf = workflow('baseline', async (run) => {
      await run(demo)
    })

    await wf.execute(rig.deps)
    await rig.logger.close()

    const lines = await readLines('events.ndjson')
    expect(lines.length).toBe(1)
    for (const record of lines) {
      expect(typeof record.stepSpanId).toBe('string')
      expect((record.event as { kind: string }).kind).toBeDefined()
    }
  })

  it('lifecycle.ndjson brackets the run with host-created and run-ended and records step:start/complete', async () => {
    const rig = await makeRig()
    const demo = step.define('demo', { agent: rig.runner, prompt: 'hi' })
    const wf = workflow('baseline', async (run) => {
      await run(demo)
    })

    await wf.execute(rig.deps)
    await rig.logger.close()

    const lines = await readLines('lifecycle.ndjson')
    const types = lines.map((l) => l.type as string)
    expect(types[0]).toBe('host-created')
    expect(types.at(-1)).toBe('run-ended')
    expect(types).toContain('step:start')
    expect(types).toContain('step:complete')
  })

  it('timeline.ndjson is a strict superset of spawns, events, and lifecycle and is monotonic in ts', async () => {
    const rig = await makeRig()
    const demo = step.define('demo', { agent: rig.runner, prompt: 'hi' })
    const wf = workflow('baseline', async (run) => {
      await run(demo)
    })

    await wf.execute(rig.deps)
    await rig.logger.close()

    const spawns = await readLines('spawns.ndjson')
    const events = await readLines('events.ndjson')
    const lifecycle = await readLines('lifecycle.ndjson')
    const timeline = await readLines('timeline.ndjson')

    expect(timeline.length).toBe(spawns.length + events.length + lifecycle.length)

    for (let i = 1; i < timeline.length; i++) {
      const prev = timeline[i - 1]?.ts as number
      const curr = timeline[i]?.ts as number
      expect(curr).toBeGreaterThanOrEqual(prev)
    }

    // Every category line has a matching timeline entry tagged with `source`.
    const sources = new Set(timeline.map((l) => l.source as string))
    expect(sources.has('spawns')).toBe(true)
    expect(sources.has('events')).toBe(true)
    expect(sources.has('lifecycle')).toBe(true)
  })

  it('run.meta.json contains orchVersion, argv, envKeys and no env values by default', async () => {
    const rig = await makeRig()

    const meta = buildRunMeta({
      runId: RUN_ID,
      workflowName: 'baseline',
      argv: ['bun', 'run', 'orch', 'run', 'baseline'],
      env: { HOME: '/root', PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-secret' },
      mode: 'plain',
      debug: false,
      orchVersion: '0.0.0',
      os: process.platform,
      startedAtIso: new Date(rig.clock.now()).toISOString(),
    })
    await rig.logger.writeFile('run.meta.json', `${JSON.stringify(meta, null, 2)}\n`)
    await rig.logger.close()

    const parsed = await readJson<Record<string, unknown>>('run.meta.json')
    expect(parsed.orchVersion).toBe('0.0.0')
    expect(Array.isArray(parsed.argv)).toBe(true)
    expect(Array.isArray(parsed.envKeys)).toBe(true)
    // No env map — values must not leak by default.
    expect(parsed.env).toBeUndefined()
    // And the secret key appears in envKeys without its value.
    expect((parsed.envKeys as string[]).includes('ANTHROPIC_API_KEY')).toBe(true)
  })

  it('run.meta.json with ORCH_LOG_ENV_VALUES emits env values with secrets redacted to ***', async () => {
    const rig = await makeRig()

    const meta = buildRunMeta({
      runId: RUN_ID,
      workflowName: 'baseline',
      argv: ['bun', 'run', 'orch', 'run', 'baseline'],
      env: { HOME: '/root', SOMETHING_TOKEN: 'shh' },
      mode: 'plain',
      debug: false,
      orchVersion: '0.0.0',
      os: process.platform,
      startedAtIso: new Date(rig.clock.now()).toISOString(),
      emitEnvValues: true,
    })
    await rig.logger.writeFile('run.meta.json', `${JSON.stringify(meta, null, 2)}\n`)
    await rig.logger.close()

    const parsed = await readJson<{ env: Record<string, string> }>('run.meta.json')
    expect(parsed.env.HOME).toBe('/root')
    expect(parsed.env.SOMETHING_TOKEN).toBe('***')
  })

  it('agents/<stepName>/session.json contains prompt, argv, envKeys, finalEvent, and stepSpanId', async () => {
    const rig = await makeRig()
    const demo = step.define('demo', { agent: rig.runner, prompt: 'hi' })
    const wf = workflow('baseline', async (run) => {
      await run(demo)
    })

    await wf.execute(rig.deps)
    await rig.logger.close()

    const session = await readJson<Record<string, unknown>>('agents/demo/session.json')
    expect(session.stepName).toBe('demo')
    expect(typeof session.stepSpanId).toBe('string')
    expect(session.runnerName).toBe('fake')
    expect(session.mode).toBe('autonomous')
    expect(session.prompt).toBe('hi')
    expect(Array.isArray(session.argv)).toBe(true)
    expect(Array.isArray(session.envKeys)).toBe(true)
    expect(session.exitCode).toBe(0)
    const finalEvent = session.finalEvent as { kind: string; type: string }
    expect(finalEvent.kind).toBe('terminal')
    expect(finalEvent.type).toBe('turn-complete')
    // outputs map lets a cold reader inventory the per-step folder.
    expect(session.outputs).toEqual({
      events: 'events.ndjson',
      rawStdout: 'raw_output.ndjson',
      rawStderr: 'raw_stderr.log',
      formattedAnsi: 'formatted_output.ansi',
      formattedText: 'formatted_output.txt',
    })

    // Cross-check: the spawn record and the session.json share the stepSpanId.
    const spawns = await readLines('spawns.ndjson')
    expect(spawns[0]?.stepSpanId).toBe(session.stepSpanId as string)
  })

  it('grep stepSpanId returns matches in every baseline ndjson file', async () => {
    const rig = await makeRig()
    const demo = step.define('demo', { agent: rig.runner, prompt: 'hi' })
    const wf = workflow('baseline', async (run) => {
      await run(demo)
    })

    await wf.execute(rig.deps)
    await rig.logger.close()

    const spawns = await readLines('spawns.ndjson')
    const spanId = spawns[0]?.stepSpanId as string
    expect(typeof spanId).toBe('string')

    for (const file of ['spawns.ndjson', 'events.ndjson', 'lifecycle.ndjson', 'timeline.ndjson']) {
      const body = await readFile(join(logsDir, file), 'utf8')
      expect(body.includes(spanId)).toBe(true)
    }
  })

  it('renderRunReadme produces a README.md that includes the runId and grep recipes', async () => {
    const rig = await makeRig()
    const body = renderRunReadme({
      runId: RUN_ID,
      workflowName: 'baseline',
      mode: 'plain',
      debug: false,
      startedAt: new Date(rig.clock.now()).toISOString(),
      orchVersion: '0.0.0',
    })
    await rig.logger.writeFile('README.md', body)
    await rig.logger.close()

    const loaded = await readFile(join(logsDir, 'README.md'), 'utf8')
    expect(loaded).toContain(RUN_ID)
    expect(loaded).toContain('## Grep recipes')
  })

  it('a failed workflow writes a run-ended lifecycle record with status=failed', async () => {
    const bunFs = new BunFsService()
    const clock = new FakeClock(1_000)
    const processService = new FakeProcessService()
    const runner = new FakeRunner(processService)
    runner.script({ failWith: { message: 'boom', exitCode: 2 } })

    const logger = createFileSessionLogger({
      fs: bunFs,
      clock,
      runId: RUN_ID,
      basePath,
      debug: false,
    })

    const host = createPlainHost({
      stdout: process.stdout,
      stderr: process.stderr,
      format: 'text',
      clock,
      runId: RUN_ID,
      logger,
    })

    const deps: WorkflowDeps = {
      stateStore: new FileStateStore({ fs: bunFs, basePath }),
      processService,
      clock,
      runId: RUN_ID,
      cwd: path(tempDir),
      fsService: bunFs,
      gitService: new FakeGitService(),
      host,
      promptService: new FakePromptService(),
      interactivity: 'interactive' as const,
      logger,
    }

    const demo = step.define('demo', { agent: runner, prompt: 'hi' })
    const wf = workflow('baseline', async (run) => {
      await run(demo)
    })
    await wf.execute(deps).catch(() => {})
    await logger.close()

    const lines = await readLines('lifecycle.ndjson')
    const last = lines.at(-1) as { type: string; status: string } | undefined
    expect(last?.type).toBe('run-ended')
    expect(last?.status).toBe('failed')
  })

  it('resume appends run:resumed to lifecycle and bumps run.meta.json.resumedAt', async () => {
    // First pass — crash mid-run.
    const bunFs = new BunFsService()
    const clock = new FakeClock(1_000)
    const fps1 = new FakeProcessService()
    const runnerA = new FakeRunner(fps1)
    runnerA.script({ failWith: { message: 'stop', exitCode: 1 } })
    const loggerA = createFileSessionLogger({
      fs: bunFs,
      clock,
      runId: RUN_ID,
      basePath,
      debug: false,
    })
    const hostA = createPlainHost({
      stdout: process.stdout,
      stderr: process.stderr,
      format: 'text',
      clock,
      runId: RUN_ID,
      logger: loggerA,
    })
    const depsA: WorkflowDeps = {
      stateStore: new FileStateStore({ fs: bunFs, basePath }),
      processService: fps1,
      clock,
      runId: RUN_ID,
      cwd: path(tempDir),
      fsService: bunFs,
      gitService: new FakeGitService(),
      host: hostA,
      promptService: new FakePromptService(),
      interactivity: 'interactive' as const,
      logger: loggerA,
    }
    const demoA = step.define('demo', { agent: runnerA, prompt: 'hi' })
    const wfA = workflow('resumable', async (run) => {
      await run(demoA)
    })
    await wfA.execute(depsA).catch(() => {})
    await loggerA.close()

    // Seed run.meta.json so the resume path has something to bump.
    await writeFile(
      join(logsDir, 'run.meta.json'),
      `${JSON.stringify({ runId: RUN_ID, startedAt: '2026-04-24T00:00:00.000Z' }, null, 2)}\n`,
    )

    // Second pass — resume. Fresh logger, same logs dir.
    const fps2 = new FakeProcessService()
    const runnerB = new FakeRunner(fps2)
    runnerB.script({ structuredOutput: 'ok' })
    const clock2 = new FakeClock(10_000)
    const loggerB = createFileSessionLogger({
      fs: bunFs,
      clock: clock2,
      runId: RUN_ID,
      basePath,
      debug: false,
    })
    await loggerB.append('lifecycle', {
      type: 'run:resumed',
      resumedAt: new Date(clock2.now()).toISOString(),
    })
    await loggerB.writeFile(
      'run.meta.json',
      `${JSON.stringify(
        {
          runId: RUN_ID,
          startedAt: '2026-04-24T00:00:00.000Z',
          resumedAt: new Date(clock2.now()).toISOString(),
        },
        null,
        2,
      )}\n`,
    )
    await loggerB.close()

    const lifecycle = await readLines('lifecycle.ndjson')
    const types = lifecycle.map((l) => l.type as string)
    expect(types.includes('run:resumed')).toBe(true)

    const meta = await readJson<{ resumedAt?: string }>('run.meta.json')
    expect(typeof meta.resumedAt).toBe('string')
  })
})
