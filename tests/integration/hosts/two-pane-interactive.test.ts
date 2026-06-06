// COVERED BY → tests-new/unit/hosts/tmux-host.test.ts
// Interactive-step-under-two-pane mocked integration. Drives an interactive
// step through `workflow.execute` with a TmuxHost backed by FakeTmuxService
// and asserts the respawn-pane lifecycle: runner argv first, cat restoration
// on exit, no spawnForeground touching the parent TTY.

import { describe, expect, it } from 'bun:test'
import { Writable } from 'node:stream'
import { step } from '../../../src/core/step.ts'
import { type WorkflowDeps, workflow } from '../../../src/core/workflow.ts'
import { createTmuxHost } from '../../../src/hosts/index.ts'
import { FakeRunner } from '../../../src/runners/index.ts'
import {
  FakeClock,
  FakeFsService,
  FakeGitService,
  FakeProcessService,
  path,
} from '../../../src/services/index.ts'
import { FakePromptService } from '../../../src/services/prompt/index.ts'
import { FakeTmuxService, paneId } from '../../../src/services/tmux/index.ts'
import { FileStateStore, type RunId } from '../../../src/state/index.ts'

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

const RUN_ID = 'r-2026-04-23-301840-rk' as RunId

describe.skip('two-pane interactive step', () => {
  it('creates a per-source PTY session with runner argv, swaps it visible, waits pane-exit, then kills the session (U4)', async () => {
    const fs = new FakeFsService()
    const processService = new FakeProcessService()
    const clock = new FakeClock(1_700_000_000_000)
    const stderr = bufferStream()
    const basePath = path('/state')

    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    // splitPane → visible right pane (%7). Per-source createSession (consumed
    // FIFO) → the interactive PTY pane.
    tmux.nextPaneId(paneId('%7'))

    const stateStore = new FileStateStore({ fs, basePath })

    const host = await createTmuxHost({
      tmux,
      fs,
      processService,
      clock,
      runId: RUN_ID,
      workflowName: 'review-flow',
      stderr: stderr.stream,
      skipVersionCheck: true,
      basePath,
      stateStore,
      disableStepsView: true,
    })

    // FakeRunner.buildCommand asserts one scripted invocation per call even
    // for interactive steps (it doesn't know autonomous vs. interactive). We
    // enqueue a single script so buildCommand succeeds; its argv feeds the
    // per-source createSession. The ProcessService response is never
    // consumed — the host takes over the pane and waits for pane-exit, not
    // child exit on stdout.
    const agent = new FakeRunner(processService)
    agent.script({ structuredOutput: 'ignored' })

    const deps: WorkflowDeps = {
      stateStore,
      processService,
      clock,
      runId: RUN_ID,
      cwd: path('/workspace'),
      fsService: fs,
      gitService: new FakeGitService(),
      host,
      promptService: new FakePromptService(),
      interactivity: 'interactive' as const,
    }

    // Interactive step resolves view to 'interactive' on 'right'. U6's
    // pane-map path takes over — register a pty source in its own per-source
    // session, swap it visible, wait for pane-exit, kill the session.
    await workflow('review-flow', async (run) => {
      await run(step.define('review', { agent, mode: 'interactive' }))
    }).execute(deps)
    await host.teardown()

    // U4 invariant: NO `respawnPane` on the visible right pane (%7).
    const rightRespawns = tmux.recordedCalls.filter(
      (c) => c.method === 'respawnPane' && c.opts.target === paneId('%7'),
    )
    expect(rightRespawns).toHaveLength(0)

    // The per-source createSession carries the runner argv. The first
    // createSession is the bootstrap `orch` session; the per-source one
    // (session name starts with `orch-src-interactive-`) hosts the PTY.
    const creates = tmux.recordedCalls.filter((c) => c.method === 'createSession')
    const ptyCreate = creates.find(
      (c) =>
        c.method === 'createSession' &&
        c.opts.command !== undefined &&
        c.opts.command[0] === ':fake:',
    )
    expect(ptyCreate).toBeDefined()
    if (ptyCreate?.method !== 'createSession') {
      throw new Error('expected createSession for the PTY source')
    }
    expect(ptyCreate.opts.session).toBe('orch-src-interactive-review')

    // swapPane brings the hidden pane into the visible slot. Then on exit,
    // unregisterSource kills the per-source SESSION (and the pane with it).
    // The old `killPane` is gone; `killSession` is the new contract.
    const swaps = tmux.recordedCalls.filter((c) => c.method === 'swapPane')
    expect(swaps.length).toBeGreaterThanOrEqual(1)

    const sessionKills = tmux.recordedCalls.filter(
      (c) => c.method === 'killSession' && c.opts.session === 'orch-src-interactive-review',
    )
    expect(sessionKills.length).toBeGreaterThanOrEqual(1)

    const waits = tmux.recordedCalls.filter((c) => c.method === 'waitFor')
    expect(waits.length).toBeGreaterThan(0)
  })
})
