// Unit tests for `tailNdjson` against real fs.
//
// Pins the line-framing contract:
//   1. Each `\n`-terminated line is delivered separately.
//   2. A trailing partial line (no `\n` yet) is buffered until the producer
//      writes the newline.
//   3. `startAtEnd: true` ignores everything written before `start()`; new
//      appends after start still fire.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import { tailNdjson } from '../../../../../src/hosts/two-pane/steps-view/index.ts'
import { path as toPath } from '../../../../../src/services/types.ts'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp('/tmp/orch-stepsview-test-')
})

afterEach(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('tailNdjson', () => {
  it('emits one onLine call per newline-terminated record found in the file', async () => {
    const filePath = `${tmpDir}/lifecycle.ndjson`
    await fs.writeFile(filePath, '{"a":1}\n{"a":2}\n')
    const lines: string[] = []
    const handle = tailNdjson({
      filePath: toPath(filePath),
      onLine: (l) => lines.push(l),
    })

    await handle.start()

    expect(lines).toEqual(['{"a":1}', '{"a":2}'])
    await handle.stop()
  })

  it('buffers a trailing partial line until the producer writes the newline', async () => {
    const filePath = `${tmpDir}/lifecycle.ndjson`
    await fs.writeFile(filePath, '{"a":1}\n{"part') // no trailing newline
    const lines: string[] = []
    const handle = tailNdjson({
      filePath: toPath(filePath),
      onLine: (l) => lines.push(l),
      pollIntervalMs: 50,
    })
    await handle.start()
    expect(lines).toEqual(['{"a":1}'])

    await fs.appendFile(filePath, 'ial":true}\n')
    await wait(400)

    expect(lines).toEqual(['{"a":1}', '{"partial":true}'])
    await handle.stop()
  })

  it('skips pre-existing content under startOffset >= size and surfaces only post-start appends', async () => {
    const filePath = `${tmpDir}/lifecycle.ndjson`
    const initial = '{"old":1}\n{"older":2}\n'
    await fs.writeFile(filePath, initial)
    const lines: string[] = []
    const handle = tailNdjson({
      filePath: toPath(filePath),
      onLine: (l) => lines.push(l),
      startOffset: Buffer.byteLength(initial, 'utf8'),
      pollIntervalMs: 50,
    })
    await handle.start()
    expect(lines).toEqual([])

    await fs.appendFile(filePath, '{"new":1}\n')
    await wait(400)

    expect(lines).toEqual(['{"new":1}'])
    await handle.stop()
  })
})
