import { describe, expect, it } from 'bun:test'
import { FakeFsService, type Path, path } from '../../../src/services/index.ts'
import { createTranscriptSidecar, type RunId, runId } from '../../../src/state/index.ts'

const BASE = path('/state')
const RID: RunId = runId('r-2026-06-11-101500-aa')

function eventsPath(step: string): Path {
  return path(`${BASE}/${RID}/logs/agents/${step}/events.ndjson`)
}

/**
 * FakeFsService that rejects the first `appendFile` call, then delegates every
 * later call to the real in-memory fake. Lets a test prove that one failing
 * write rejects its caller without poisoning the serial chain — without
 * mocking any internal module (the fake is the sanctioned fs edge).
 */
class FailFirstAppendFsService extends FakeFsService {
  #failed = false

  override async appendFile(p: Path, data: string): Promise<void> {
    if (!this.#failed) {
      this.#failed = true
      throw new Error('Simulated appendFile failure')
    }
    await super.appendFile(p, data)
  }
}

describe('createTranscriptSidecar', () => {
  it('truncates stale content on the first append of the process', async () => {
    const fs = new FakeFsService()
    await fs.mkdir(path(`${BASE}/${RID}/logs/agents/build`), { recursive: true })
    await fs.writeFile(eventsPath('build'), '{"stale":true}\n{"old":1}\n')
    const sidecar = createTranscriptSidecar({ fs, runId: RID, basePath: BASE })

    await sidecar.forStep('build').append({ a: 1 })

    expect(await fs.readFile(eventsPath('build'))).toBe('{"a":1}\n')
  })

  it('accumulates appended events in call order and counts them', async () => {
    const fs = new FakeFsService()
    const sidecar = createTranscriptSidecar({ fs, runId: RID, basePath: BASE })
    const step = sidecar.forStep('plan')

    await step.append({ n: 1 })
    await step.append({ n: 2 })
    await step.append({ n: 3 })

    expect(await fs.readFile(eventsPath('plan'))).toBe('{"n":1}\n{"n":2}\n{"n":3}\n')
    expect(step.snapshot().transcriptEventCount).toBe(3)
  })

  it('serializes concurrent appends into whole non-interleaved lines', async () => {
    const fs = new FakeFsService()
    const sidecar = createTranscriptSidecar({ fs, runId: RID, basePath: BASE })
    const step = sidecar.forStep('review')

    await Promise.all([step.append({ n: 1 }), step.append({ n: 2 }), step.append({ n: 3 })])

    expect(await fs.readFile(eventsPath('review'))).toBe('{"n":1}\n{"n":2}\n{"n":3}\n')
    expect(step.snapshot().transcriptEventCount).toBe(3)
  })

  it('rejects the caller on a failing write but keeps the chain alive for later appends', async () => {
    const fs = new FailFirstAppendFsService()
    const sidecar = createTranscriptSidecar({ fs, runId: RID, basePath: BASE })
    const step = sidecar.forStep('flaky')

    await expect(step.append({ first: true })).rejects.toThrow('Simulated appendFile failure')
    expect(step.snapshot().transcriptEventCount).toBe(0)

    await step.append({ second: true })

    expect(await fs.readFile(eventsPath('flaky'))).toBe('{"second":true}\n')
    expect(step.snapshot().transcriptEventCount).toBe(1)
  })

  it('reports a snapshot path relative to the run directory, never the basePath', async () => {
    const fs = new FakeFsService()
    const sidecar = createTranscriptSidecar({ fs, runId: RID, basePath: BASE })
    const step = sidecar.forStep('emit')

    await step.append({ k: 'v' })
    const snapshot = step.snapshot()

    expect(snapshot.transcriptPath).toBe('logs/agents/emit/events.ndjson')
    expect(snapshot.transcriptPath.startsWith(BASE)).toBe(false)
    expect(snapshot.transcriptEventCount).toBe(1)
  })

  it('sanitizes step names so every non [a-zA-Z0-9_-] char becomes an underscore', async () => {
    const fs = new FakeFsService()
    const sidecar = createTranscriptSidecar({ fs, runId: RID, basePath: BASE })
    const rawName = 'review: src/foo.ts'
    const expectedDir = rawName.replace(/[^a-zA-Z0-9_-]/g, '_')

    await sidecar.forStep(rawName).append({ ok: true })

    expect(expectedDir).toBe('review__src_foo_ts')
    expect(await fs.exists(eventsPath(expectedDir))).toBe(true)
  })

  it('caches one handle per step name and continues the count across lookups', async () => {
    const fs = new FakeFsService()
    const sidecar = createTranscriptSidecar({ fs, runId: RID, basePath: BASE })

    const first = sidecar.forStep('x')
    await first.append({ i: 1 })
    const second = sidecar.forStep('x')
    await second.append({ i: 2 })

    expect(second).toBe(first)
    expect(second.snapshot().transcriptEventCount).toBe(2)
    expect(await fs.readFile(eventsPath('x'))).toBe('{"i":1}\n{"i":2}\n')
  })
})
