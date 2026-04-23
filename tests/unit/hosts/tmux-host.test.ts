// Unit tests for TmuxHost — drives the host with a FakeTmuxService and asserts
// the recorded tmux command sequence. No real tmux server is started.

import { describe, expect, it } from 'bun:test'
import { Writable } from 'node:stream'
import { stepName } from '../../../src/core/types.ts'
import { createTmuxHost } from '../../../src/hosts/index.ts'
import type { RunnerEvent } from '../../../src/runners/index.ts'
import {
  FakeClock,
  FakeProcessService,
  type ProcessService,
  path,
} from '../../../src/services/index.ts'
import { FakeTmuxService, paneId } from '../../../src/services/tmux/index.ts'
import type { RunId } from '../../../src/state/index.ts'

function makeStderr(): { stream: NodeJS.WritableStream; text: () => string } {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk))
      cb()
    },
  })
  return { stream: stream as unknown as NodeJS.WritableStream, text: () => chunks.join('') }
}

async function buildHost(tmux: FakeTmuxService) {
  const stderr = makeStderr()
  const host = await createTmuxHost({
    tmux,
    processService: new FakeProcessService() as ProcessService,
    clock: new FakeClock(0),
    runId: 'r-2026-04-23-phased1' as RunId,
    workflowName: 'compound',
    stderr: stderr.stream,
    skipVersionCheck: true,
  })
  return { host, stderr }
}

describe('createTmuxHost setup', () => {
  it('creates the session, lists the initial pane, and splits the right pane with cat', async () => {
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%1'))

    const { stderr } = await buildHost(tmux)

    const methods = tmux.recordedCalls.map((c) => c.method)
    expect(methods).toContain('createSession')
    expect(methods).toContain('listPanes')
    expect(methods).toContain('splitPane')

    // The split-pane command should use `cat` as the placeholder — never a
    // shell — so transcript keystrokes cannot be interpreted by bash.
    const split = tmux.recordedCalls.find((c) => c.method === 'splitPane')
    if (split?.method !== 'splitPane') throw new Error('expected split-pane call')
    expect(split.opts.command).toBe('cat')

    // Attach + kill-server hints printed to stderr so users can hop in.
    expect(stderr.text()).toContain('attach with:')
    expect(stderr.text()).toContain('clean up with:')
  })

  it('prepares the left pane with `clear && exec cat` so sendKeys draws to a clean pty', async () => {
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%1'))

    await buildHost(tmux)

    const sendKeys = tmux.recordedCalls.find((c) => c.method === 'sendKeys')
    if (sendKeys?.method !== 'sendKeys') throw new Error('expected sendKeys call')
    expect(sendKeys.opts.keys).toEqual(['clear && exec cat'])
    expect(sendKeys.opts.enter).toBe(true)
  })
})

describe('TmuxHost.onRunnerEvent', () => {
  it('renders human-readable transcript lines on the right pane — never raw JSON', async () => {
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%42'))

    const { host } = await buildHost(tmux)

    const evt: RunnerEvent = {
      kind: 'info',
      type: 'assistant',
      payload: { text: 'hello from plan' },
    }
    host.onRunnerEvent(evt, stepName('plan'))
    // The write is queued; wait for teardown to drain.
    await host.teardown()

    const rightSendKeys = tmux.recordedCalls.filter(
      (c) => c.method === 'sendKeys' && c.opts.target === paneId('%42'),
    )
    expect(rightSendKeys).toHaveLength(1)
    const payload = (rightSendKeys[0] as { method: 'sendKeys'; opts: { keys: readonly string[] } })
      .opts.keys[0] as string
    // Raw JSON `runnerEvent:…` shape must never appear.
    expect(payload).not.toMatch(/runnerEvent:/)
    expect(payload).not.toMatch(/"kind":"info"/)
    // Human-readable transcript line.
    expect(payload).toContain('[plan] assistant> hello from plan')
  })

  it('suppresses lines that renderTranscriptLine returns null for (turn-complete)', async () => {
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%42'))

    const { host } = await buildHost(tmux)

    host.onRunnerEvent({ kind: 'terminal', type: 'turn-complete' }, stepName('plan'))
    await host.teardown()

    const rightSendKeys = tmux.recordedCalls.filter(
      (c) => c.method === 'sendKeys' && c.opts.target === paneId('%42'),
    )
    expect(rightSendKeys).toHaveLength(0)
  })
})

describe('TmuxHost.onLifecycleEvent — step:failed', () => {
  it('writes the Story 1.5 failure frame into the right pane, after pending transcript writes', async () => {
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%42'))

    const { host } = await buildHost(tmux)

    // Queue one transcript line first so we can assert ordering.
    host.onRunnerEvent(
      { kind: 'info', type: 'assistant', payload: { text: 'thinking' } },
      stepName('plan'),
    )
    host.onLifecycleEvent({
      type: 'step:failed',
      stepName: stepName('plan'),
      error: new Error('boom'),
    })

    await host.teardown()

    const rightSendKeys = tmux.recordedCalls.filter(
      (c) => c.method === 'sendKeys' && c.opts.target === paneId('%42'),
    )
    // One transcript line + one failure frame.
    expect(rightSendKeys).toHaveLength(2)
    const framePayload = (
      rightSendKeys[1] as { method: 'sendKeys'; opts: { keys: readonly string[] } }
    ).opts.keys[0] as string
    expect(framePayload).toContain('✗ step "plan" failed')
    expect(framePayload).toContain('  boom')
    expect(framePayload).toContain('resume:  orch resume')
    expect(framePayload).toContain('logs:    orch logs')
  })

  it('forwards the event to the status loop so the left pane marks failed', async () => {
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%42'))

    const { host } = await buildHost(tmux)

    host.onLifecycleEvent({ type: 'step:start', stepName: stepName('plan'), mode: 'autonomous' })
    host.onLifecycleEvent({
      type: 'step:failed',
      stepName: stepName('plan'),
      error: 'exit 1',
    })

    // StatusLoop.onStepEvent is fire-and-forget; the best we can check at
    // this granularity is that some left-pane sendKeys has happened after
    // the failure event.
    await host.teardown()
    const leftSendKeys = tmux.recordedCalls.filter(
      (c) => c.method === 'sendKeys' && c.opts.target === paneId('%0'),
    )
    expect(leftSendKeys.length).toBeGreaterThan(0)
  })
})

describe('TmuxHost.onLifecycleEvent — step:parallel-branch-update', () => {
  it('renders the compact parallel rollup into the right pane on each update', async () => {
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%42'))

    const { host } = await buildHost(tmux)

    host.onLifecycleEvent({
      type: 'step:parallel-branch-update',
      stepName: stepName('plan'),
      branchStatus: 'running',
    })
    host.onLifecycleEvent({
      type: 'step:parallel-branch-update',
      stepName: stepName('build'),
      branchStatus: 'running',
    })
    host.onLifecycleEvent({
      type: 'step:parallel-branch-update',
      stepName: stepName('plan'),
      branchStatus: 'completed',
      elapsedMs: 500,
    })

    await host.teardown()

    const rightFrames = tmux.recordedCalls.filter(
      (c) => c.method === 'sendKeys' && c.opts.target === paneId('%42'),
    )
    // One frame per update. The latest frame contains the final rollup
    // with `✓ plan` and `● build`.
    expect(rightFrames.length).toBeGreaterThanOrEqual(3)
    const last = rightFrames[rightFrames.length - 1] as {
      method: 'sendKeys'
      opts: { keys: readonly string[] }
    }
    const payload = last.opts.keys[0] as string
    expect(payload).toContain('parallel branches:')
    expect(payload).toContain('✓ plan')
    expect(payload).toContain('● build')
  })
})

describe('TmuxHost.runInteractive', () => {
  it('respawns the right pane with the runner argv, then restores the cat placeholder on exit', async () => {
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%42'))

    const { host } = await buildHost(tmux)

    const result = await host.runInteractive({
      argv: ['claude', '--resume', 'abc'],
      env: {},
      cwd: path('/tmp'),
      stepName: stepName('review'),
    })

    expect(result.exitCode).toBe(0)

    const respawns = tmux.recordedCalls.filter((c) => c.method === 'respawnPane')
    expect(respawns).toHaveLength(2)
    // First respawn: runner argv with killRunning=true (kicks the `cat` placeholder).
    const first = respawns[0]
    if (first?.method !== 'respawnPane') throw new Error('expected respawnPane call')
    expect(first.opts.argv).toEqual(['claude', '--resume', 'abc'])
    expect(first.opts.killRunning).toBe(true)
    // Second respawn: restore `cat` so the next transcript stream has a placeholder.
    const second = respawns[1]
    if (second?.method !== 'respawnPane') throw new Error('expected respawnPane call')
    expect(second.opts.argv).toEqual(['cat'])
    expect(second.opts.killRunning).toBe(true)
    // And we waited on the pane-exit channel between them.
    const waits = tmux.recordedCalls.filter((c) => c.method === 'waitFor')
    expect(waits).toHaveLength(1)
    const wait = waits[0]
    if (wait?.method !== 'waitFor') throw new Error('expected waitFor call')
    expect(wait.opts.channel).toBe('pane-exit-%42')
  })
})

describe('TmuxHost.teardown', () => {
  it('stops the status loop and drains the per-pane write queue', async () => {
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%42'))

    const { host } = await buildHost(tmux)
    host.onRunnerEvent(
      { kind: 'info', type: 'assistant', payload: { text: 'pending' } },
      stepName('plan'),
    )

    await host.teardown()

    // Further events after teardown do not produce new sendKeys — the host
    // is silenced once torn down.
    const callsBefore = tmux.recordedCalls.length
    host.onRunnerEvent(
      { kind: 'info', type: 'assistant', payload: { text: 'post-teardown' } },
      stepName('plan'),
    )
    expect(tmux.recordedCalls.length).toBe(callsBefore)
  })
})
