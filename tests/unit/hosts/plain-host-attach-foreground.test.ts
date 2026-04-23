// PlainHost.attachForeground — the plain host never takes the TTY. Its
// workflow stream IS the foreground, so attach is a resolved-immediately
// no-op. This guarantees the CLI's Promise.race(workflow, attach) collapses
// to "wait for the workflow" under --mode=plain without any special casing.

import { describe, expect, it } from 'bun:test'
import { Writable } from 'node:stream'
import { createPlainHost } from '../../../src/hosts/index.ts'
import { FakeClock, FakeProcessService } from '../../../src/services/index.ts'
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

const RUN_ID = 'r-2026-04-23-aaaaaa' as RunId

describe('PlainHost.attachForeground', () => {
  it('resolves immediately with no subprocess spawn', async () => {
    const stdout = bufferStream()
    const stderr = bufferStream()
    const processService = new FakeProcessService()
    const host = createPlainHost({
      stdout: stdout.stream,
      stderr: stderr.stream,
      format: 'text',
      clock: new FakeClock(0),
      runId: RUN_ID,
      processService,
    })

    await expect(host.attachForeground()).resolves.toBeUndefined()
    // No bytes written and no scripted response consumed — the call is inert.
    expect(stdout.text()).toBe('')
    expect(stderr.text()).toBe('')
  })
})
