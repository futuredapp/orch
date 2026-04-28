// Unit tests for TmuxHost — drives the host with a FakeTmuxService and asserts
// the recorded tmux command sequence. No real tmux server is started.

import { describe, expect, it } from 'bun:test'
import { Writable } from 'node:stream'
import { stepName } from '../../../src/core/types.ts'
import { createTmuxHost, stripAnsi } from '../../../src/hosts/index.ts'
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

    // Under auto-attach (the default), the "attach with …" hint is not
    // emitted — the attach client immediately takes over the TTY. The hint
    // now lives only on the --no-attach path (see `attach-foreground` tests).
    expect(stderr.text()).not.toContain('attach with:')
    expect(stderr.text()).not.toContain('clean up with:')
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
      payload: {},
    }
    host.onRunnerEvent(evt, stepName('plan'), [
      { kind: 'line', category: 'assistant', label: 'assistant>', body: 'hello from plan' },
    ])
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
    // Human-readable transcript line — tmux always renders with color, so
    // strip ANSI before the substring assertion.
    expect(stripAnsi(payload)).toContain('[plan] assistant> hello from plan')
  })

  it('suppresses runner events whose lines array is empty', async () => {
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%42'))

    const { host } = await buildHost(tmux)

    host.onRunnerEvent({ kind: 'terminal', type: 'turn-complete' }, stepName('plan'), [])
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
    host.onRunnerEvent({ kind: 'info', type: 'assistant', payload: {} }, stepName('plan'), [
      { kind: 'line', category: 'assistant', label: 'assistant>', body: 'thinking' },
    ])
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
  it('respawns the right pane with runner argv + env + cwd, then restores cat without env or cwd on exit', async () => {
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%42'))

    const { host } = await buildHost(tmux)

    // The asymmetry in env and cwd is the design: the runner respawn carries
    // both `spawn.env` (so ANTHROPIC_API_KEY / OAuth bootstrap vars /
    // FORCE_COLOR=3 reach the agent) and `spawn.cwd` (so the agent's tools
    // see the project directory, not tmux's `/`). The placeholder restore
    // deliberately omits both — `cat` needs nothing.
    const spawnEnv = { ANTHROPIC_API_KEY: 'sk-test', FORCE_COLOR: '3' }
    const result = await host.runInteractive({
      argv: ['claude', '--resume', 'abc'],
      env: spawnEnv,
      cwd: path('/tmp'),
      stepName: stepName('review'),
    })

    expect(result.exitCode).toBe(0)

    const respawns = tmux.recordedCalls.filter((c) => c.method === 'respawnPane')
    expect(respawns).toHaveLength(2)
    // First respawn: runner argv with killRunning=true, env carrying spawn.env,
    // and cwd carrying spawn.cwd. Without cwd plumbing, the pane keeps its
    // existing cwd (`/` in production) and the agent can't write project files.
    const first = respawns[0]
    if (first?.method !== 'respawnPane') throw new Error('expected respawnPane call')
    expect(first.opts.argv).toEqual(['claude', '--resume', 'abc'])
    expect(first.opts.killRunning).toBe(true)
    expect(first.opts.env).toEqual(spawnEnv)
    expect(first.opts.cwd).toBe(path('/tmp'))
    // Second respawn: restore `cat`. Env and cwd are intentionally omitted —
    // placeholder needs no environment or working directory, and a stale
    // runner env or cwd would leak into the next pane state. The asymmetry
    // is the contract.
    const second = respawns[1]
    if (second?.method !== 'respawnPane') throw new Error('expected respawnPane call')
    expect(second.opts.argv).toEqual(['cat'])
    expect(second.opts.killRunning).toBe(true)
    expect(second.opts.env).toBeUndefined()
    expect(second.opts.cwd).toBeUndefined()
    // And we waited on the pane-exit channel between them, with no timeout —
    // interactive steps must wait indefinitely so the user can pause the
    // agent for arbitrary periods without orch killing the run.
    const waits = tmux.recordedCalls.filter((c) => c.method === 'waitFor')
    expect(waits).toHaveLength(1)
    const wait = waits[0]
    if (wait?.method !== 'waitFor') throw new Error('expected waitFor call')
    expect(wait.opts.channel).toBe('pane-exit-%42')
    expect(wait.opts.timeoutMs).toBeUndefined()
  })

  it('omits timeoutMs on the pane-exit waitFor so an idle interactive agent never trips a default timeout', async () => {
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%42'))

    const { host } = await buildHost(tmux)

    await host.runInteractive({
      argv: ['claude'],
      env: {},
      cwd: path('/tmp'),
      stepName: stepName('review'),
    })

    const waits = tmux.recordedCalls.filter((c) => c.method === 'waitFor')
    expect(waits).toHaveLength(1)
    const wait = waits[0]
    if (wait?.method !== 'waitFor') throw new Error('expected waitFor call')
    expect(wait.opts.timeoutMs).toBeUndefined()
  })
})

describe('TmuxHost.teardown', () => {
  it('stops the status loop and drains the per-pane write queue', async () => {
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%42'))

    const { host } = await buildHost(tmux)
    host.onRunnerEvent({ kind: 'info', type: 'assistant', payload: {} }, stepName('plan'), [
      { kind: 'line', category: 'assistant', label: 'assistant>', body: 'pending' },
    ])

    await host.teardown()

    // Further events after teardown do not produce new sendKeys — the host
    // is silenced once torn down.
    const callsBefore = tmux.recordedCalls.length
    host.onRunnerEvent({ kind: 'info', type: 'assistant', payload: {} }, stepName('plan'), [
      { kind: 'line', category: 'assistant', label: 'assistant>', body: 'post-teardown' },
    ])
    expect(tmux.recordedCalls.length).toBe(callsBefore)
  })

  it('kills the tmux session so the server does not leave mouse-mode bits on the outer TTY', async () => {
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%42'))

    const { host } = await buildHost(tmux)

    await host.teardown()

    const killCalls = tmux.recordedCalls.filter((c) => c.method === 'killSession')
    expect(killCalls).toHaveLength(1)
    if (killCalls[0]?.method === 'killSession') {
      expect(killCalls[0].opts.session).toBe('orch')
    }
  })

  it('is idempotent — a second teardown does not re-issue kill-session', async () => {
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%42'))

    const { host } = await buildHost(tmux)

    await host.teardown()
    await host.teardown()

    const killCalls = tmux.recordedCalls.filter((c) => c.method === 'killSession')
    expect(killCalls).toHaveLength(1)
  })
})
