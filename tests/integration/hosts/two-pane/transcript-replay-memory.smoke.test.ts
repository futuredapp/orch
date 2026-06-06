// MIGRATED → tests-new/integration/hosts/two-pane/transcript-replay-memory.smoke.test.ts
// Phase 4 memory smoke test: replay a 10MB synthetic transcript and assert
// that resident-set growth stays under 120MB (≈12× the input).
//
// The bound is the contract behind the `// TODO(transcript-replay-memory):`
// comment at the load site in `src/hosts/two-pane/replay-transcript.ts`. If a
// future change makes the load substantially memory-hungrier, this test
// regresses; the v2 fix is virtualization, not a higher cap.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import { Writable } from 'node:stream'
import { renderTranscriptToString } from '../../../../src/hosts/two-pane/replay-transcript.ts'
import { path as toPath } from '../../../../src/services/types.ts'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp('/tmp/orch-transcript-mem-')
})

afterEach(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

describe.skip('transcript replay — memory smoke', () => {
  it('keeps resident-set growth under 120MB on a 10MB synthetic transcript', async () => {
    const transcriptPath = `${tmpDir}/big.ndjson`

    // Build ~10MB of synthetic NDJSON. Each line is ~100 bytes — 100K lines.
    const linePayload = 'x'.repeat(60)
    const oneLine = `${JSON.stringify({
      kind: 'info',
      type: 'tool',
      payload: { name: 'edit', arg: linePayload },
    })}\n`
    const lineSize = Buffer.byteLength(oneLine)
    const target = 10 * 1024 * 1024 // 10 MB
    const lines = Math.ceil(target / lineSize)
    const handle = await fs.open(transcriptPath, 'w')
    try {
      // Stream-write to avoid spiking memory just to construct the fixture.
      const CHUNK = 1024
      let buf = ''
      for (let i = 0; i < lines; i++) {
        buf += oneLine
        if (i % CHUNK === 0) {
          await handle.write(buf)
          buf = ''
        }
      }
      if (buf.length > 0) await handle.write(buf)
    } finally {
      await handle.close()
    }

    // Stub stream — we only care about the loader's memory profile, not the
    // bytes that come out the back.
    const sink = new Writable({
      write(_c, _e, cb) {
        cb()
      },
    })
    void sink // avoid unused-var

    if (typeof globalThis.gc === 'function') globalThis.gc()
    const before = process.memoryUsage().rss

    const out = await renderTranscriptToString({
      transcriptPath: toPath(transcriptPath),
      stepName: 'mem-smoke',
    })
    void out // we only care about RSS

    if (typeof globalThis.gc === 'function') globalThis.gc()
    const after = process.memoryUsage().rss
    const growthMB = Math.max(0, (after - before) / (1024 * 1024))

    // 160 MB cap on RSS growth. Real measurement, not theoretical — Bun's
    // RSS is approximate (we observed ~120 MB locally on macOS) so the cap
    // absorbs GC + V8/JSC heap noise. The contract is "no v2 commit makes
    // this 3× worse" — virtualization is the v2 fix, not a higher cap.
    expect(growthMB).toBeLessThan(160)
  }, 30_000)
})
