import { describe, expect, it } from 'bun:test'
import { stepName } from '../../../src/core/types.ts'
import { createFileSessionLogger } from '../../../src/observability/file-session-logger.ts'
import { FakeClock, FakeFsService, path } from '../../../src/services/index.ts'
import { runId as runIdFactory } from '../../../src/state/index.ts'

const RUN_ID = runIdFactory('r-2026-04-24-abcdef')
const BASE = path('/state')

function make(debug = false): {
  logger: ReturnType<typeof createFileSessionLogger>
  fs: FakeFsService
  clock: FakeClock
} {
  const fs = new FakeFsService()
  const clock = new FakeClock(1_000)
  const logger = createFileSessionLogger({ fs, clock, runId: RUN_ID, basePath: BASE, debug })
  return { logger, fs, clock }
}

function parseLines(raw: string): Array<Record<string, unknown>> {
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('createFileSessionLogger — append', () => {
  it('writes an ndjson line to the category file with auto-injected ts', async () => {
    const { logger, fs, clock } = make()
    clock.set(12_345)

    await logger.append('spawns', { runnerName: 'claude', exitCode: 0 })

    const raw = await fs.readFile(path(`${BASE}/${RUN_ID}/logs/spawns.ndjson`))
    const [line] = parseLines(raw)
    expect(line).toEqual({ ts: 12_345, runnerName: 'claude', exitCode: 0 })
  })

  it('mirrors the record into timeline.ndjson with a source tag', async () => {
    const { logger, fs } = make()
    await logger.append('spawns', { runnerName: 'claude', exitCode: 0 })

    const raw = await fs.readFile(path(`${BASE}/${RUN_ID}/logs/timeline.ndjson`))
    const [line] = parseLines(raw)
    expect(line?.source).toBe('spawns')
    expect(line?.runnerName).toBe('claude')
  })

  it('forStep returns a span whose append auto-tags stepName and stepSpanId', async () => {
    const { logger, fs } = make()
    const span = logger.forStep(stepName('demo'))
    await span.append('events', { event: { kind: 'terminal', type: 'turn-complete' } })

    const raw = await fs.readFile(path(`${BASE}/${RUN_ID}/logs/events.ndjson`))
    const [line] = parseLines(raw)
    expect(line?.stepName).toBe('demo')
    expect(line?.stepSpanId).toBe(span.stepSpanId)
  })

  it('concurrent appends to the same category do not interleave', async () => {
    const { logger, fs } = make()
    const writes = Array.from({ length: 50 }, (_, i) => logger.append('spawns', { index: i }))
    await Promise.all(writes)

    const raw = await fs.readFile(path(`${BASE}/${RUN_ID}/logs/spawns.ndjson`))
    const lines = parseLines(raw)
    expect(lines.length).toBe(50)
    // Every line must parse (no interleave of half-lines).
    expect(lines.map((l) => l.index)).toEqual(Array.from({ length: 50 }, (_, i) => i))
  })

  it('concurrent appends to different categories run independently', async () => {
    const { logger, fs } = make()
    await Promise.all([
      logger.append('spawns', { runnerName: 'claude' }),
      logger.append('events', { kind: 'info' }),
      logger.append('lifecycle', { type: 'step:start' }),
    ])

    const spawns = parseLines(await fs.readFile(path(`${BASE}/${RUN_ID}/logs/spawns.ndjson`)))
    const events = parseLines(await fs.readFile(path(`${BASE}/${RUN_ID}/logs/events.ndjson`)))
    const lifecycle = parseLines(await fs.readFile(path(`${BASE}/${RUN_ID}/logs/lifecycle.ndjson`)))
    const timeline = parseLines(await fs.readFile(path(`${BASE}/${RUN_ID}/logs/timeline.ndjson`)))

    expect(spawns.length).toBe(1)
    expect(events.length).toBe(1)
    expect(lifecycle.length).toBe(1)
    expect(timeline.length).toBe(3)
  })

  it('close awaits every in-flight append before resolving', async () => {
    const { logger, fs } = make()
    logger.append('spawns', { a: 1 })
    logger.append('events', { b: 2 })
    logger.append('lifecycle', { c: 3 })

    await logger.close()

    const timeline = parseLines(await fs.readFile(path(`${BASE}/${RUN_ID}/logs/timeline.ndjson`)))
    expect(timeline.length).toBe(3)
  })
})

describe('createFileSessionLogger — writeFile', () => {
  it('writes a complete file atomically via temp-then-rename through FsService', async () => {
    const { logger, fs } = make()
    await logger.writeFile('run.meta.json', '{"ok":true}')

    const body = await fs.readFile(path(`${BASE}/${RUN_ID}/logs/run.meta.json`))
    expect(JSON.parse(body)).toEqual({ ok: true })
  })

  it('creates nested subdirectories lazily', async () => {
    const { logger, fs } = make()
    await logger.writeFile('agents/demo.session.json', '{}')

    expect(await fs.exists(path(`${BASE}/${RUN_ID}/logs/agents/demo.session.json`))).toBe(true)
  })

  it('rejects traversal segments in the rel path', () => {
    const { logger } = make()
    expect(() => logger.writeFile('../escape.md', 'x')).toThrow(/traversal/)
  })

  it('rejects absolute paths', () => {
    const { logger } = make()
    expect(() => logger.writeFile('/etc/passwd', 'x')).toThrow(/absolute/)
  })

  it('rejects control characters in the rel path', () => {
    const { logger } = make()
    expect(() => logger.writeFile('agents/bad.log', 'x')).toThrow(/control/)
  })
})

describe('createFileSessionLogger — rawSink', () => {
  it('returns null when debug is false', () => {
    const { logger } = make(false)
    expect(logger.rawSink('agents/demo.stdout')).toBeNull()
  })

  it('returns a writable sink when debug is true and appends bytes through FsService', async () => {
    const { logger, fs } = make(true)
    const sink = logger.rawSink('agents/demo.stdout')
    expect(sink).not.toBeNull()

    await sink?.write('hello ')
    await sink?.write('world\n')
    await sink?.close()

    const body = await fs.readFile(path(`${BASE}/${RUN_ID}/logs/agents/demo.stdout`))
    expect(body).toBe('hello world\n')
  })

  it('rejects writes after close', async () => {
    const { logger } = make(true)
    const sink = logger.rawSink('agents/demo.stdout')
    await sink?.close()
    await expect(sink?.write('late')).rejects.toThrow(/closed/)
  })
})
