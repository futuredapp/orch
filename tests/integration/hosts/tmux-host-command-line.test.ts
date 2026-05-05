// tmux host: `onCommandLine` enqueues raw line bytes onto the resolved pane.

import { describe, expect, it } from 'bun:test'
import { Writable } from 'node:stream'
import { stepName } from '../../../src/core/types.ts'
import { createTmuxHost } from '../../../src/hosts/index.ts'
import { FakeClock, FakeProcessService } from '../../../src/services/index.ts'
import { FakeTmuxService, paneId } from '../../../src/services/tmux/index.ts'
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

const RUN_ID = 'r-2026-05-05-100000-tc' as RunId

interface Harness {
  readonly host: Awaited<ReturnType<typeof createTmuxHost>>
  readonly tmux: FakeTmuxService
  readonly leftPane: ReturnType<typeof paneId>
  readonly rightPane: ReturnType<typeof paneId>
  teardown(): Promise<void>
}

async function makeHarness(): Promise<Harness> {
  const stderr = bufferStream()
  const tmux = new FakeTmuxService()
  // Left = %0 (initial pane); right = %7 (split pane).
  tmux.setListPanesResult(['%0'])
  tmux.nextPaneId(paneId('%7'))

  const host = await createTmuxHost({
    tmux,
    processService: new FakeProcessService(),
    clock: new FakeClock(0),
    runId: RUN_ID,
    workflowName: 'test',
    stderr: stderr.stream,
    skipVersionCheck: true,
  })

  return {
    host,
    tmux,
    leftPane: paneId('%0'),
    rightPane: paneId('%7'),
    async teardown() {
      await host.teardown()
    },
  }
}

function paneWrites(tmux: FakeTmuxService, target: ReturnType<typeof paneId>): string[] {
  return tmux.recordedCalls
    .filter((c) => c.method === 'sendKeys' && c.opts.target === target)
    .map((c) => (c.method === 'sendKeys' ? c.opts.keys.join('') : ''))
}

describe('TmuxHost.onCommandLine', () => {
  it('enqueues right-pane writes by default', async () => {
    const h = await makeHarness()
    h.host.onCommandLine({
      stream: 'stdout',
      line: 'hello',
      step: stepName('command:tests'),
      pane: 'right',
    })
    await h.teardown()

    const writes = paneWrites(h.tmux, h.rightPane).join('|')
    expect(writes).toContain('hello\r\n')
  })

  it("with pane:'left' enqueues left-pane writes", async () => {
    const h = await makeHarness()
    h.host.onCommandLine({
      stream: 'stdout',
      line: 'sidebar',
      step: stepName('command:status'),
      pane: 'left',
    })
    await h.teardown()

    const writes = paneWrites(h.tmux, h.leftPane).join('|')
    expect(writes).toContain('sidebar\r\n')
  })

  it('preserves ANSI escape sequences byte-for-byte (no [step] prefix)', async () => {
    const h = await makeHarness()
    const ansi = '[31mred[0m'
    h.host.onCommandLine({
      stream: 'stdout',
      line: ansi,
      step: stepName('command:colorful'),
      pane: 'right',
    })
    await h.teardown()

    const writes = paneWrites(h.tmux, h.rightPane).join('')
    // Bytes go through verbatim — no prefix added.
    expect(writes).toContain(`${ansi}\r\n`)
    expect(writes).not.toContain('[command:colorful]')
  })

  it('drops writes after teardown without throwing', async () => {
    const h = await makeHarness()
    await h.teardown()

    expect(() =>
      h.host.onCommandLine({
        stream: 'stdout',
        line: 'too late',
        step: stepName('command:late'),
        pane: 'right',
      }),
    ).not.toThrow()
  })
})
