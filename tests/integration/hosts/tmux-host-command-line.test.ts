// tmux host: `onCommandLine` writes raw line bytes to the per-step tee.
//
// U5 dropped the legacy `sendKeys`-on-pane fan-out for command lines. Every
// byte the host emits for a command step now flows through the per-step
// `formatted_output.ansi` tee. A hidden `file-tail` pane in the scratch
// session (registered on `step:start`, mode 'autonomous' — see workflow.ts)
// mirrors the bytes into the visible right pane via swap-pane. The `pane`
// field on `CommandLine` no longer toggles the visible target — the steps-
// view daemon owns the left pane and command output never lands there.

import { describe, expect, it } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { Writable } from 'node:stream'
import { stepName } from '../../../src/core/types.ts'
import { createTmuxHost } from '../../../src/hosts/index.ts'
import { createFileSessionLogger } from '../../../src/observability/index.ts'
import { BunFsService, FakeClock, FakeProcessService, path } from '../../../src/services/index.ts'
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

// `step:start` opens the tee behind the lifecycle choreographer's FIFO queue,
// so the open is no longer synchronous with `onLifecycleEvent` returning. In
// production the subprocess spawn between `step:start` and the first command
// line provides this ordering; here we poll for the starting-marker the open
// writes before firing `onCommandLine`, mirroring the `waitForFile` idiom the
// autonomous-live-pane integration test already uses.
async function waitForTeeOpen(absPath: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const body = await readFile(absPath, 'utf8').catch(() => '')
    if (body.includes('starting…')) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`tee did not open within ${timeoutMs}ms: ${absPath}`)
}

interface Harness {
  readonly host: Awaited<ReturnType<typeof createTmuxHost>>
  readonly tmux: FakeTmuxService
  readonly leftPane: ReturnType<typeof paneId>
  readonly rightPane: ReturnType<typeof paneId>
  readonly basePath: ReturnType<typeof path>
  readonly fs: BunFsService
  readonly logger: ReturnType<typeof createFileSessionLogger>
  readonly tempDir: string
  teardown(): Promise<void>
}

async function makeHarness(): Promise<Harness> {
  const tempDir = await mkdtemp(`${tmpdir()}/orch-u5-cmd-`)
  const stderr = bufferStream()
  const tmux = new FakeTmuxService()
  tmux.setListPanesResult(['%0'])
  tmux.nextPaneId(paneId('%7'))
  const basePath = path(`${tempDir}/state`)
  const fs = new BunFsService()
  const logger = createFileSessionLogger({
    fs,
    clock: new FakeClock(0),
    runId: RUN_ID,
    basePath,
    debug: false,
  })

  const host = await createTmuxHost({
    tmux,
    processService: new FakeProcessService(),
    clock: new FakeClock(0),
    runId: RUN_ID,
    workflowName: 'test',
    stderr: stderr.stream,
    skipVersionCheck: true,
    logger,
  })

  return {
    host,
    tmux,
    leftPane: paneId('%0'),
    rightPane: paneId('%7'),
    basePath,
    fs,
    logger,
    tempDir,
    async teardown() {
      await host.teardown()
      await logger.close()
    },
  }
}

function paneWrites(tmux: FakeTmuxService, target: ReturnType<typeof paneId>): string[] {
  return tmux.recordedCalls
    .filter((c) => c.method === 'sendKeys' && c.opts.target === target)
    .map((c) => (c.method === 'sendKeys' ? c.opts.keys.join('') : ''))
}

describe('TmuxHost.onCommandLine', () => {
  it('writes command bytes to the per-step tee, not to the right pane', async () => {
    const h = await makeHarness()
    // The tee must be open before write — emitted by `step:start` for command
    // steps (mode: 'autonomous'). See workflow.ts onCommandStep.
    h.host.onLifecycleEvent({
      type: 'step:start',
      stepName: stepName('command:tests'),
      mode: 'autonomous',
    })
    await waitForTeeOpen(`${h.basePath}/${RUN_ID}/logs/agents/command:tests/formatted_output.ansi`)
    h.host.onCommandLine({
      stream: 'stdout',
      line: 'hello',
      step: stepName('command:tests'),
      pane: 'right',
    })
    h.host.onLifecycleEvent({
      type: 'step:complete',
      stepName: stepName('command:tests'),
      durationMs: 1,
    })
    await h.teardown()

    // No direct sendKeys on the right pane — file-tail handles visibility.
    const rightWrites = paneWrites(h.tmux, h.rightPane).join('|')
    expect(rightWrites).toBe('')

    const tee = await h.fs.readFile(
      path(`${h.basePath}/${RUN_ID}/logs/agents/command:tests/formatted_output.ansi`),
    )
    expect(tee).toContain('hello\r\n')
  })

  it("ignores pane:'left' — command bytes still flow to the tee, not the left pane", async () => {
    const h = await makeHarness()
    h.host.onLifecycleEvent({
      type: 'step:start',
      stepName: stepName('command:status'),
      mode: 'autonomous',
    })
    await waitForTeeOpen(`${h.basePath}/${RUN_ID}/logs/agents/command:status/formatted_output.ansi`)
    h.host.onCommandLine({
      stream: 'stdout',
      line: 'sidebar',
      step: stepName('command:status'),
      pane: 'left',
    })
    h.host.onLifecycleEvent({
      type: 'step:complete',
      stepName: stepName('command:status'),
      durationMs: 1,
    })
    await h.teardown()

    // The left pane is owned by the steps-view daemon. Command output never
    // lands there in the new model — the pane field is an honored no-op.
    const leftWrites = paneWrites(h.tmux, h.leftPane).filter((w) => w.includes('sidebar'))
    expect(leftWrites).toHaveLength(0)

    const tee = await h.fs.readFile(
      path(`${h.basePath}/${RUN_ID}/logs/agents/command:status/formatted_output.ansi`),
    )
    expect(tee).toContain('sidebar\r\n')
  })

  it('preserves ANSI escape sequences byte-for-byte in the tee (no [step] prefix)', async () => {
    const h = await makeHarness()
    const ansi = '[31mred[0m'
    h.host.onLifecycleEvent({
      type: 'step:start',
      stepName: stepName('command:colorful'),
      mode: 'autonomous',
    })
    await waitForTeeOpen(
      `${h.basePath}/${RUN_ID}/logs/agents/command:colorful/formatted_output.ansi`,
    )
    h.host.onCommandLine({
      stream: 'stdout',
      line: ansi,
      step: stepName('command:colorful'),
      pane: 'right',
    })
    h.host.onLifecycleEvent({
      type: 'step:complete',
      stepName: stepName('command:colorful'),
      durationMs: 1,
    })
    await h.teardown()

    const tee = await h.fs.readFile(
      path(`${h.basePath}/${RUN_ID}/logs/agents/command:colorful/formatted_output.ansi`),
    )
    expect(tee).toContain(`${ansi}\r\n`)
    // Per-line command output MUST NOT be prefixed with `[step] `. The
    // step:start starting-marker is a one-shot cue and is allowed to mention
    // the step name; per-line bytes from `onCommandLine` must stay raw.
    expect(tee).not.toContain(`[command:colorful] ${ansi}`)
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
