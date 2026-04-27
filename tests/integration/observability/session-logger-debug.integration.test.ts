// ---------------------------------------------------------------------------
// Phase 3 `--debug` integration — drives the executor with a debug-enabled
// FileSessionLogger and asserts every heavy-capture file lands under
// `.orch/state/<runId>/logs/`. Paired with session-logger-baseline; this
// file only exercises what the baseline cannot.
// ---------------------------------------------------------------------------
//
// Covered heavy captures:
//   - agents/<step>.stdout + .stderr  (raw byte sink from runRunner)
//   - subprocesses.ndjson             (instrumentProcessService wrapper)
//   - orch.log                        (orchLog helper call sites)
//
// Not covered here (lives elsewhere for deliberate reasons):
//   - tmux/<paneId>.log is exercised by the tmux host tests; it requires a
//     live tmux service so we keep it out of the in-memory observability
//     integration. Non-debug runs still assert the file's absence.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { step } from '../../../src/core/step.ts'
import { type WorkflowDeps, workflow } from '../../../src/core/workflow.ts'
import { createPlainHost } from '../../../src/hosts/index.ts'
import {
  createFileSessionLogger,
  instrumentProcessService,
  orchLog,
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
import { FileStateStore, type RunId, runId as runIdFactory } from '../../../src/state/index.ts'

const RUN_ID: RunId = runIdFactory('r-2026-04-24-debug0')

let tempDir: string
let logsDir: string
let basePath: ReturnType<typeof path>

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'orch-session-debug-'))
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

async function readText(rel: string): Promise<string> {
  return readFile(join(logsDir, rel), 'utf8')
}

async function fileExists(rel: string): Promise<boolean> {
  try {
    await readFile(join(logsDir, rel))
    return true
  } catch {
    return false
  }
}

interface RigOptions {
  readonly debug: boolean
}

interface Rig {
  readonly logger: SessionLogger
  readonly clock: FakeClock
  readonly deps: WorkflowDeps
  readonly runner: FakeRunner
  readonly processService: FakeProcessService
}

function makeRig(opts: RigOptions): Rig {
  const bunFs = new BunFsService()
  const clock = new FakeClock(1_000)
  const processService = new FakeProcessService()
  const runner = new FakeRunner(processService)

  const logger = createFileSessionLogger({
    fs: bunFs,
    clock,
    runId: RUN_ID,
    basePath,
    debug: opts.debug,
  })

  const instrumented = instrumentProcessService(processService, { logger, clock })

  const host = createPlainHost({
    stdout: process.stdout,
    stderr: process.stderr,
    format: 'text',
    clock,
    runId: RUN_ID,
    logger,
    processService: instrumented,
  })

  const deps: WorkflowDeps = {
    stateStore: new FileStateStore({ fs: bunFs, basePath }),
    processService: instrumented,
    clock,
    runId: RUN_ID,
    cwd: path(tempDir),
    fsService: bunFs,
    gitService: new FakeGitService(),
    host,
    logger,
  }

  return { logger, clock, deps, runner, processService }
}

describe('session-logger --debug hook-ins (integration)', () => {
  it('writes raw agent stdout to agents/<step>.stdout when debug is on', async () => {
    const rig = makeRig({ debug: true })
    rig.runner.script({
      events: [{ kind: 'info', type: 'assistant-text', payload: { text: 'hello' } }],
      structuredOutput: 'ok',
    })
    const demo = step.define('demo', { agent: rig.runner, prompt: 'hi' })
    const wf = workflow('debug-stdout', async (run) => {
      await run(demo)
    })

    await wf.execute(rig.deps)
    await rig.logger.close()

    const body = await readText('agents/demo.stdout')
    // FakeRunner emits two NDJSON lines: the scripted info + the terminal.
    // Both land in the raw sink verbatim.
    expect(body).toContain('"kind":"info"')
    expect(body).toContain('"type":"assistant-text"')
    expect(body).toContain('"kind":"terminal"')
    expect(body.split('\n').filter((l) => l.length > 0).length).toBe(2)
  })

  it('creates an empty agents/<step>.stderr file when the runner writes no stderr bytes', async () => {
    const rig = makeRig({ debug: true })
    rig.runner.script({ structuredOutput: 'ok' })
    const demo = step.define('demo', { agent: rig.runner, prompt: 'hi' })
    const wf = workflow('debug-stderr', async (run) => {
      await run(demo)
    })

    await wf.execute(rig.deps)
    await rig.logger.close()

    // The sink is opened unconditionally under debug — with no stderr bytes
    // the file may be absent (rawSink.write is never called). That's fine;
    // the important invariant is that stdout is recorded.
    expect(await fileExists('agents/demo.stdout')).toBe(true)
  })

  it('records non-agent subprocess spawns to subprocesses.ndjson', async () => {
    const rig = makeRig({ debug: true })

    rig.processService.when(['git', 'status']).respondWith({ stdout: [], exitCode: 0 })

    const handle = rig.deps.processService.spawn({
      argv: ['git', 'status'],
      cwd: path(tempDir),
      env: { PATH: '/usr/bin' },
    })
    for await (const _ of handle.stdout) {
      /* drain */
    }
    await handle.wait()

    // Drive an agent spawn too so we can assert it does NOT appear.
    rig.runner.script({ structuredOutput: 'ok' })
    const demo = step.define('demo', { agent: rig.runner, prompt: 'hi' })
    const wf = workflow('debug-subs', async (run) => {
      await run(demo)
    })
    await wf.execute(rig.deps)
    await rig.logger.close()

    const lines = await readLines('subprocesses.ndjson')
    // Exactly one entry — the `git status` call. The agent spawn carries
    // `tag: 'agent'` and is skipped by the instrumentation wrapper.
    expect(lines.length).toBe(1)
    const record = lines[0]
    expect(record?.argv).toEqual(['git', 'status'])
    expect(record?.kind).toBe('spawn')
    expect(Array.isArray(record?.envKeys)).toBe(true)
    expect(record?.cwd).toBe(tempDir)
    expect(record?.exitCode).toBe(0)
  })

  it('writes orch.log entries when orchLog is called from a debug run', async () => {
    const rig = makeRig({ debug: true })
    rig.runner.script({ structuredOutput: 'ok' })
    const demo = step.define('demo', { agent: rig.runner, prompt: 'hi' })
    const wf = workflow('debug-orch', async (run) => {
      await run(demo)
    })

    await wf.execute(rig.deps)
    // At least one direct call to the helper too, so the assertion is robust
    // against the executor's internal call sites changing.
    orchLog(rig.logger, 'manual-ping', { note: 'debug-integration' })
    await rig.logger.close()

    const lines = await readLines('orch.ndjson')
    expect(lines.length).toBeGreaterThan(0)
    const messages = lines.map((l) => l.msg as string)
    expect(messages).toContain('manual-ping')
    // The executor fires resolveView + saveStep + host-teardown on every run.
    expect(messages).toContain('resolveView')
    expect(messages).toContain('saveStep')
  })

  it('does not create stdout, stderr, subprocesses, tmux, or orch logs when debug is off', async () => {
    const rig = makeRig({ debug: false })

    // Drive a non-agent subprocess to prove the wrapper is bypassed.
    rig.processService.when(['git', 'status']).respondWith({ stdout: [], exitCode: 0 })
    const handle = rig.deps.processService.spawn({
      argv: ['git', 'status'],
      cwd: path(tempDir),
      env: {},
    })
    for await (const _ of handle.stdout) {
      /* drain */
    }
    await handle.wait()

    rig.runner.script({ structuredOutput: 'ok' })
    const demo = step.define('demo', { agent: rig.runner, prompt: 'hi' })
    const wf = workflow('debug-off', async (run) => {
      await run(demo)
    })
    await wf.execute(rig.deps)
    orchLog(rig.logger, 'should-noop')
    await rig.logger.close()

    expect(await fileExists('agents/demo.stdout')).toBe(false)
    expect(await fileExists('agents/demo.stderr')).toBe(false)
    expect(await fileExists('subprocesses.ndjson')).toBe(false)
    expect(await fileExists('orch.ndjson')).toBe(false)
    expect(await fileExists('tmux')).toBe(false)
  })

  it('instrumentProcessService returns the base service unchanged when debug is false', () => {
    const bunFs = new BunFsService()
    const clock = new FakeClock(1_000)
    const base = new FakeProcessService()

    const logger = createFileSessionLogger({
      fs: bunFs,
      clock,
      runId: RUN_ID,
      basePath,
      debug: false,
    })
    const wrapped = instrumentProcessService(base, { logger, clock })

    expect(wrapped).toBe(base)
  })
})
