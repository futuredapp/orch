// MIGRATED → tests-new/integration/observability/resume-per-step-folder.test.ts (parent U13) — relocated verbatim (import paths only); kept skipped on disk (D2).
// ---------------------------------------------------------------------------
// resume-per-step-folder — asserts that a resumed step's per-step folder
// reflects only the latest attempt. The transcript sidecar, raw stdout
// capture, and per-step render tee all truncate-on-first-write per process.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'bun:test'
import { stepName } from '../../../src/core/types.ts'
import { createPerStepTee } from '../../../src/hosts/plain/per-step-tee.ts'
import { createFileSessionLogger } from '../../../src/observability/file-session-logger.ts'
import { FakeClock, FakeFsService, path } from '../../../src/services/index.ts'
import { runId as runIdFactory } from '../../../src/state/index.ts'
import { createTranscriptSidecar } from '../../../src/state/transcript-sidecar.ts'

const RUN_ID = runIdFactory('r-2026-04-28-000000-rs')
const BASE = path('/state')

async function readSafely(fs: FakeFsService, p: ReturnType<typeof path>): Promise<string> {
  try {
    return await fs.readFile(p)
  } catch {
    return '<absent>'
  }
}

describe.skip('resume truncates per-step append-only files', () => {
  it('events.ndjson reflects only the latest attempt after resume', async () => {
    const fs = new FakeFsService()
    const step = stepName('demo')

    // First attempt — writes two events then crashes.
    const sidecarA = createTranscriptSidecar({ fs, runId: RUN_ID, basePath: BASE })
    const handleA = sidecarA.forStep(step)
    await handleA.append({ kind: 'info', payload: 'old-1' })
    await handleA.append({ kind: 'info', payload: 'old-2' })

    // Sanity: the file holds the prior attempt's two lines.
    const before = await fs.readFile(path(`${BASE}/${RUN_ID}/logs/agents/demo/events.ndjson`))
    expect(before.split('\n').filter((l) => l.length > 0).length).toBe(2)

    // Second attempt — fresh process, fresh sidecar instance — re-runs the step.
    const sidecarB = createTranscriptSidecar({ fs, runId: RUN_ID, basePath: BASE })
    const handleB = sidecarB.forStep(step)
    await handleB.append({ kind: 'info', payload: 'new-1' })

    const after = await fs.readFile(path(`${BASE}/${RUN_ID}/logs/agents/demo/events.ndjson`))
    const lines = after.split('\n').filter((l) => l.length > 0)
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain('new-1')
    expect(lines[0]).not.toContain('old-1')
  })

  it('streamSink with truncateOnOpen wipes raw_output.ndjson on resume', async () => {
    const fs = new FakeFsService()
    const clock = new FakeClock(0)

    // First attempt.
    const loggerA = createFileSessionLogger({
      fs,
      clock,
      runId: RUN_ID,
      basePath: BASE,
      debug: false,
    })
    const sinkA = loggerA.streamSink('agents/demo/raw_output.ndjson', { truncateOnOpen: true })
    await sinkA.write('old-1\n')
    await sinkA.write('old-2\n')
    await sinkA.close()
    await loggerA.close()

    // Second attempt — new process, new logger instance.
    const loggerB = createFileSessionLogger({
      fs,
      clock,
      runId: RUN_ID,
      basePath: BASE,
      debug: false,
    })
    const sinkB = loggerB.streamSink('agents/demo/raw_output.ndjson', { truncateOnOpen: true })
    await sinkB.write('new-1\n')
    await sinkB.close()
    await loggerB.close()

    const body = await fs.readFile(path(`${BASE}/${RUN_ID}/logs/agents/demo/raw_output.ndjson`))
    expect(body).toBe('new-1\n')
  })

  it('per-step render tee truncates formatted_output.ansi/.txt on resume', async () => {
    const fs = new FakeFsService()
    const clock = new FakeClock(0)
    const step = stepName('demo')

    // First attempt.
    const loggerA = createFileSessionLogger({
      fs,
      clock,
      runId: RUN_ID,
      basePath: BASE,
      debug: false,
    })
    const teeA = createPerStepTee(loggerA)
    teeA.open(step)
    teeA.write(step, 'old line\n')
    teeA.close(step)
    await teeA.drain()
    await loggerA.close()

    // Second attempt.
    const loggerB = createFileSessionLogger({
      fs,
      clock,
      runId: RUN_ID,
      basePath: BASE,
      debug: false,
    })
    const teeB = createPerStepTee(loggerB)
    teeB.open(step)
    teeB.write(step, 'new line\n')
    teeB.close(step)
    await teeB.drain()
    await loggerB.close()

    const ansi = await fs.readFile(path(`${BASE}/${RUN_ID}/logs/agents/demo/formatted_output.ansi`))
    const txt = await fs.readFile(path(`${BASE}/${RUN_ID}/logs/agents/demo/formatted_output.txt`))
    expect(ansi).toBe('new line\n')
    expect(txt).toBe('new line\n')
  })

  it('non-truncate streamSink appends across instances (control case)', async () => {
    const fs = new FakeFsService()
    const clock = new FakeClock(0)

    const loggerA = createFileSessionLogger({
      fs,
      clock,
      runId: RUN_ID,
      basePath: BASE,
      debug: false,
    })
    const sinkA = loggerA.streamSink('agents/demo/raw_output.ndjson')
    await sinkA.write('a\n')
    await sinkA.close()
    await loggerA.close()

    const loggerB = createFileSessionLogger({
      fs,
      clock,
      runId: RUN_ID,
      basePath: BASE,
      debug: false,
    })
    const sinkB = loggerB.streamSink('agents/demo/raw_output.ndjson')
    await sinkB.write('b\n')
    await sinkB.close()
    await loggerB.close()

    const body = await readSafely(fs, path(`${BASE}/${RUN_ID}/logs/agents/demo/raw_output.ndjson`))
    expect(body).toBe('a\nb\n')
  })
})
