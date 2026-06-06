// MIGRATED → tests-new/integration/observability/session-logger.e2e.test.ts (parent U13) — relocated verbatim (import paths only); kept skipped on disk (D2).
// ---------------------------------------------------------------------------
// Phase 1 acceptance test — drives FileSessionLogger against a real tempdir
// via BunFsService, simulating the hook-points the executor will wire in
// Phase 2. Proves every baseline file lands with the expected shape and that
// `grep <stepSpanId>` finds the step across every ndjson file.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stepName } from '../../../src/core/types.ts'
import { createFileSessionLogger, renderRunReadme } from '../../../src/observability/index.ts'
import { BunClock, BunFsService, path } from '../../../src/services/index.ts'
import { runId as runIdFactory } from '../../../src/state/index.ts'

const RUN_ID = runIdFactory('r-2026-04-24-950814-ei')

let tempDir: string
let logsDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'orch-logger-e2e-'))
  logsDir = join(tempDir, '.orch', 'state', RUN_ID, 'logs')
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

async function readJson<T>(rel: string): Promise<T> {
  const body = await readFile(join(logsDir, rel), 'utf8')
  return JSON.parse(body) as T
}

async function readLines(rel: string): Promise<Array<Record<string, unknown>>> {
  const body = await readFile(join(logsDir, rel), 'utf8')
  return body
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

async function fileExists(rel: string): Promise<boolean> {
  try {
    await readFile(join(logsDir, rel))
    return true
  } catch {
    return false
  }
}

async function driveOneStepWorkflow(): Promise<string> {
  const fs = new BunFsService()
  const clock = new BunClock()
  const basePath = path(join(tempDir, '.orch', 'state'))
  const logger = createFileSessionLogger({
    fs,
    clock,
    runId: RUN_ID,
    basePath,
    debug: false,
  })

  // Simulate run init — run.meta.json + README.md.
  const startedAtIso = new Date(clock.now()).toISOString()
  await logger.writeFile(
    'run.meta.json',
    JSON.stringify(
      {
        orchVersion: '0.0.0',
        runId: RUN_ID,
        argv: ['bun', 'run', 'demo'],
        envKeys: ['HOME', 'PATH'],
        os: process.platform,
        startedAt: startedAtIso,
      },
      null,
      2,
    ),
  )
  await logger.writeFile(
    'README.md',
    renderRunReadme({
      runId: RUN_ID,
      workflowName: 'demo',
      mode: 'plain',
      debug: false,
      startedAt: startedAtIso,
      orchVersion: '0.0.0',
    }),
  )

  // Host-created lifecycle.
  await logger.append('lifecycle', { type: 'host-created', mode: 'plain' })

  // One step: start, spawn, event, complete, session.json.
  const span = logger.forStep(stepName('demo'))
  await span.append('lifecycle', { type: 'step:start', mode: 'autonomous' })
  await span.append('spawns', {
    runnerName: 'fake',
    mode: 'autonomous',
    argv: ['fake', '--prompt', 'hi'],
    envKeys: ['PATH'],
    cwd: tempDir,
    exitCode: 0,
    durationMs: 5,
    reproduce: "cd /tmp && PATH=/usr/bin fake --prompt 'hi'",
  })
  await span.append('events', { event: { kind: 'terminal', type: 'turn-complete' } })
  await span.append('lifecycle', { type: 'step:complete', durationMs: 5 })

  await logger.writeFile(
    `agents/${span.stepName}/session.json`,
    JSON.stringify(
      {
        stepName: span.stepName,
        stepSpanId: span.stepSpanId,
        runnerName: 'fake',
        mode: 'autonomous',
        prompt: 'hi',
        argv: ['fake', '--prompt', 'hi'],
        envKeys: ['PATH'],
        finalEvent: { kind: 'terminal', type: 'turn-complete' },
        exitCode: 0,
        durationMs: 5,
        transcriptPath: `logs/agents/${span.stepName}/events.ndjson`,
      },
      null,
      2,
    ),
  )

  // Run-ended lifecycle.
  await logger.append('lifecycle', { type: 'run-ended', status: 'completed', totalDurationMs: 5 })

  await logger.close()
  return span.stepSpanId
}

describe.skip('session-logger e2e acceptance', () => {
  it('writes the full baseline logs directory after a one-step workflow', async () => {
    await driveOneStepWorkflow()

    expect(await fileExists('spawns.ndjson')).toBe(true)
    expect(await fileExists('events.ndjson')).toBe(true)
    expect(await fileExists('lifecycle.ndjson')).toBe(true)
    expect(await fileExists('timeline.ndjson')).toBe(true)
    expect(await fileExists('run.meta.json')).toBe(true)
    expect(await fileExists('README.md')).toBe(true)
    expect(await fileExists('agents/demo/session.json')).toBe(true)
    // Baseline run should not produce debug-only files.
    expect(await fileExists('subprocesses.ndjson')).toBe(false)
    expect(await fileExists('orch.log')).toBe(false)
  })

  it('writes run.meta.json with the expected keys and no env values', async () => {
    await driveOneStepWorkflow()

    const meta = await readJson<Record<string, unknown>>('run.meta.json')
    expect(typeof meta.orchVersion).toBe('string')
    expect(Array.isArray(meta.argv)).toBe(true)
    expect(Array.isArray(meta.envKeys)).toBe(true)
    expect(typeof meta.runId).toBe('string')
    expect(typeof meta.startedAt).toBe('string')
    // Values must not leak — only `envKeys`.
    expect(meta.env).toBeUndefined()
  })

  it('writes spawns.ndjson with one record per agent spawn', async () => {
    await driveOneStepWorkflow()
    const lines = await readLines('spawns.ndjson')
    expect(lines.length).toBe(1)
    const [record] = lines
    expect(record?.stepName).toBe('demo')
    expect(record?.runnerName).toBe('fake')
    expect(record?.mode).toBe('autonomous')
    expect(typeof record?.stepSpanId).toBe('string')
    expect(typeof record?.durationMs).toBe('number')
    expect(record?.exitCode).toBe(0)
    expect(Array.isArray(record?.argv)).toBe(true)
    expect(Array.isArray(record?.envKeys)).toBe(true)
    expect(typeof record?.reproduce).toBe('string')
  })

  it('writes events.ndjson with one record per RunnerEvent', async () => {
    await driveOneStepWorkflow()
    const lines = await readLines('events.ndjson')
    expect(lines.length).toBe(1)
    const [record] = lines
    expect(record?.stepName).toBe('demo')
    expect(typeof record?.stepSpanId).toBe('string')
    const ev = record?.event as { kind: string; type: string }
    expect(ev.kind).toBe('terminal')
    expect(ev.type).toBe('turn-complete')
  })

  it('writes lifecycle.ndjson bracketed by host-created and run-ended', async () => {
    await driveOneStepWorkflow()
    const lines = await readLines('lifecycle.ndjson')
    expect(lines.length).toBeGreaterThanOrEqual(4)
    expect(lines[0]?.type).toBe('host-created')
    expect(lines.at(-1)?.type).toBe('run-ended')
    // Step lifecycle contains step:start and step:complete.
    const types = lines.map((l) => l.type as string)
    expect(types).toContain('step:start')
    expect(types).toContain('step:complete')
  })

  it('writes timeline.ndjson as a sorted superset of the three ndjson streams', async () => {
    await driveOneStepWorkflow()
    const spawns = await readLines('spawns.ndjson')
    const events = await readLines('events.ndjson')
    const lifecycle = await readLines('lifecycle.ndjson')
    const timeline = await readLines('timeline.ndjson')

    expect(timeline.length).toBe(spawns.length + events.length + lifecycle.length)

    // Monotonic non-decreasing on ts.
    for (let i = 1; i < timeline.length; i++) {
      const prev = timeline[i - 1]?.ts as number
      const curr = timeline[i]?.ts as number
      expect(curr).toBeGreaterThanOrEqual(prev)
    }

    // Every spawns record appears in timeline tagged with source=spawns.
    const spawnIds = spawns.map((s) => s.stepSpanId as string)
    const timelineSpawnIds = timeline
      .filter((l) => l.source === 'spawns')
      .map((l) => l.stepSpanId as string)
    expect(timelineSpawnIds.sort()).toEqual(spawnIds.sort())
  })

  it('writes agents/demo/session.json with prompt, argv, envKeys, finalEvent, exitCode', async () => {
    const spanId = await driveOneStepWorkflow()
    const session = await readJson<Record<string, unknown>>('agents/demo/session.json')
    expect(session.stepName).toBe('demo')
    expect(session.stepSpanId).toBe(spanId)
    expect(session.prompt).toBe('hi')
    expect(Array.isArray(session.argv)).toBe(true)
    expect(Array.isArray(session.envKeys)).toBe(true)
    expect(session.exitCode).toBe(0)
    const final = session.finalEvent as { kind: string; type: string }
    expect(final.kind).toBe('terminal')
    expect(final.type).toBe('turn-complete')
  })

  it('writes README.md with the runId and the grep recipes heading', async () => {
    await driveOneStepWorkflow()
    const body = await readFile(join(logsDir, 'README.md'), 'utf8')
    expect(body).toContain(RUN_ID)
    expect(body).toContain('## Grep recipes')
    expect(body).toContain("grep '<stepSpanId>'")
  })

  it('grep stepSpanId returns matches in every baseline ndjson file', async () => {
    const spanId = await driveOneStepWorkflow()

    const filesToCheck = [
      'spawns.ndjson',
      'events.ndjson',
      'lifecycle.ndjson',
      'timeline.ndjson',
      'agents/demo/session.json',
    ]
    for (const f of filesToCheck) {
      const body = await readFile(join(logsDir, f), 'utf8')
      expect(body).toContain(spanId)
    }
  })
})
