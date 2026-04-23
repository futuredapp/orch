// Gated real tmux test — spins up a real tmux session via setupTmux, drives a
// FakeRunner workflow through it, and uses `capture-pane` to confirm rendered
// step names reached the live pane. Each test uses its own socket; afterEach
// kills the server.

import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import { Writable } from 'node:stream'
import { setupTmux } from '../../../src/cli/tmux-wiring.ts'
import { step } from '../../../src/core/step.ts'
import { workflow } from '../../../src/core/workflow.ts'
import { FakeRunner } from '../../../src/runners/index.ts'
import {
  BunClock,
  BunFsService,
  FakeGitService,
  FakeProcessService,
  path,
} from '../../../src/services/index.ts'
import { BunProcessService } from '../../../src/services/process/index.ts'
import { paneId, RealTmuxService, type SocketName } from '../../../src/services/tmux/index.ts'
import { FileStateStore, type RunId } from '../../../src/state/index.ts'

const canRun = Bun.which('tmux') !== null

const rid = (s: string): RunId => s as RunId

const sockets: SocketName[] = []

afterEach(async () => {
  while (sockets.length > 0) {
    const s = sockets.pop() as SocketName
    const proc = Bun.spawn(['tmux', '-L', s, 'kill-server'], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    await proc.exited
  }
})

function makeStderrBuffer(): { write: NodeJS.WritableStream['write']; text: () => string } {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk))
      cb()
    },
  })
  return {
    write: stream.write.bind(stream),
    text: () => chunks.join(''),
  }
}

describe.skipIf(!canRun)('setupTmux against a real tmux server', () => {
  it('drives step names into a live tmux status pane', async () => {
    const bunProc = new BunProcessService()
    const runId = rid(
      `r-2026-04-14-rwx${Math.floor(Math.random() * 1e3)
        .toString()
        .padStart(3, '0')}`,
    )
    const stderr = makeStderrBuffer()

    // Inject a RealTmuxService so we can also capture the rendered pane.
    const tmux = new RealTmuxService({ processService: bunProc })

    const handles = await setupTmux({
      processService: bunProc,
      clock: new BunClock(),
      runId,
      workflowName: 'realwf',
      observe: false,
      stderr: stderr as unknown as NodeJS.WritableStream,
      tmuxService: tmux,
    })
    sockets.push(handles.socket)

    // Drive one step through the workflow. FakeRunner doesn't touch tmux.
    const bunFs = new BunFsService()
    const tmpBase = path(await fs.mkdtemp('/tmp/orch-tmux-real-'))
    const fakeFps = new FakeProcessService()
    const agent = new FakeRunner(fakeFps)
    agent.script({ structuredOutput: 'ok' })

    const wf = workflow('realwf', async (run) => {
      await run(step.define('brainstorm', { agent }))
    })

    await wf.execute({
      stateStore: new FileStateStore({ fs: bunFs, basePath: tmpBase }),
      processService: fakeFps,
      clock: new BunClock(),
      runId,
      cwd: tmpBase,
      fsService: bunFs,
      gitService: new FakeGitService(),
      workflowName: 'realwf',
      onStepEvent: handles.onStepEvent,
      tmuxActive: true,
    })

    // Let the status loop flush.
    await new Promise((resolve) => setTimeout(resolve, 200))

    // Find the pane the status loop writes to. listPanes returns the single
    // initial pane id — same one setupTmux replaced with `exec cat`.
    const panes = await tmux.listPanes({
      socket: handles.socket,
      session: 'orch',
      format: '#{pane_id}',
    })
    expect(panes.length).toBeGreaterThan(0)

    const first = panes[0]
    if (first === undefined) throw new Error('listPanes returned no panes')
    const captured = await tmux.capturePane({
      socket: handles.socket,
      target: paneId(first),
    })

    // Either the rendered status text or the step name itself should appear.
    expect(captured).toContain('brainstorm')

    await handles.teardown()
    await fs.rm(tmpBase, { recursive: true, force: true })
  })
})
