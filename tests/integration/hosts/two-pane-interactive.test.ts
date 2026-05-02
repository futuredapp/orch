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

describe('two-pane interactive step', () => {
  it('respawns the right pane with runner argv, waits pane-exit, then restores cat', async () => {
    const fs = new FakeFsService()
    const processService = new FakeProcessService()
    const clock = new FakeClock(1_700_000_000_000)
    const stderr = bufferStream()

    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%7'))

    const host = await createTmuxHost({
      tmux,
      processService,
      clock,
      runId: RUN_ID,
      workflowName: 'review-flow',
      stderr: stderr.stream,
      skipVersionCheck: true,
    })

    // FakeRunner.buildCommand asserts one scripted invocation per call even
    // for interactive steps (it doesn't know autonomous vs. interactive). We
    // enqueue a single script so buildCommand succeeds; its argv feeds
    // respawnPane. The ProcessService response is never consumed — the host
    // takes over the pane and waits for pane-exit, not child exit on stdout.
    const agent = new FakeRunner(processService)
    agent.script({ structuredOutput: 'ignored' })

    const deps: WorkflowDeps = {
      stateStore: new FileStateStore({ fs, basePath: path('/runs') }),
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

    // Interactive step resolves view to 'interactive' on 'right'. The host's
    // runInteractive path takes over — respawn-pane lifecycle fires.
    await workflow('review-flow', async (run) => {
      await run(step.define('review', { agent, mode: 'interactive' }))
    }).execute(deps)
    await host.teardown()

    const respawns = tmux.recordedCalls.filter((c) => c.method === 'respawnPane')
    expect(respawns.length).toBe(2)

    const first = respawns[0]
    if (first?.method !== 'respawnPane') throw new Error('expected respawnPane')
    expect(first.opts.killRunning).toBe(true)
    expect(first.opts.argv[0]).toBe(':fake:')

    const last = respawns[respawns.length - 1]
    if (last?.method !== 'respawnPane') throw new Error('expected respawnPane')
    expect(last.opts.argv).toEqual(['cat'])

    const waits = tmux.recordedCalls.filter((c) => c.method === 'waitFor')
    expect(waits.length).toBeGreaterThan(0)
  })
})
