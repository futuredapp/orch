// MIGRATED → tests-new/integration/hosts/plain-host-command-line.test.ts (parent U12) — relocated verbatim (import paths only); kept skipped on disk (D2).
// plain host: `onCommandLine` rendering — text and JSON formats.

import { describe, expect, it } from 'bun:test'
import { Writable } from 'node:stream'
import { stepName } from '../../../src/core/types.ts'
import { createPlainHost } from '../../../src/hosts/index.ts'
import { FakeClock } from '../../../src/services/index.ts'
import type { RunId } from '../../../src/state/index.ts'

function bufferStream(): { stream: NodeJS.WritableStream; text: () => string } {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk))
      cb()
    },
  })
  return { stream: stream as unknown as NodeJS.WritableStream, text: () => chunks.join('') }
}

const RUN_ID = 'r-2026-05-05-100000-pc' as RunId

describe.skip('PlainHost.onCommandLine — text format', () => {
  it('writes [<step>] line to stdout for stdout stream', () => {
    const stdout = bufferStream()
    const stderr = bufferStream()
    const host = createPlainHost({
      stdout: stdout.stream,
      stderr: stderr.stream,
      format: 'text',
      clock: new FakeClock(0),
      runId: RUN_ID,
    })

    host.onCommandLine({
      stream: 'stdout',
      line: 'hello world',
      step: stepName('command:tests'),
      pane: 'right',
    })

    expect(stdout.text()).toBe('[command:tests] hello world\n')
    expect(stderr.text()).toBe('')
  })

  it('routes stderr stream to opts.stderr', () => {
    const stdout = bufferStream()
    const stderr = bufferStream()
    const host = createPlainHost({
      stdout: stdout.stream,
      stderr: stderr.stream,
      format: 'text',
      clock: new FakeClock(0),
      runId: RUN_ID,
    })

    host.onCommandLine({
      stream: 'stderr',
      line: 'oops',
      step: stepName('command:tests'),
      pane: 'right',
    })

    expect(stderr.text()).toBe('[command:tests] oops\n')
    expect(stdout.text()).toBe('')
  })
})

describe.skip('PlainHost.onCommandLine — json format', () => {
  it('emits an NDJSON command-line envelope on stdout', () => {
    const stdout = bufferStream()
    const stderr = bufferStream()
    const host = createPlainHost({
      stdout: stdout.stream,
      stderr: stderr.stream,
      format: 'json',
      clock: new FakeClock(1_700_000_000_000),
      runId: RUN_ID,
    })

    host.onCommandLine({
      stream: 'stdout',
      line: 'hello',
      step: stepName('command:tests'),
      pane: 'right',
    })

    const out = stdout.text().trim()
    const parsed = JSON.parse(out)
    expect(parsed.ev).toBe('command-line')
    expect(parsed.step).toBe('command:tests')
    expect(parsed.stream).toBe('stdout')
    expect(parsed.line).toBe('hello')
  })
})
