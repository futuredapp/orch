// Unit tests for TmuxHost — drives the host with a FakeTmuxService and asserts
// the recorded tmux command sequence. No real tmux server is started.

import { describe, expect, it } from 'bun:test'
import { Writable } from 'node:stream'
import { stepName } from '../../../src/core/types.ts'
import { createTmuxHost } from '../../../src/hosts/index.ts'
import type { RunnerEvent } from '../../../src/runners/index.ts'
import { FakeFsService } from '../../../src/services/fs/index.ts'
import {
  FakeClock,
  FakeProcessService,
  type ProcessService,
  path,
} from '../../../src/services/index.ts'
import { FakeTmuxService, paneId } from '../../../src/services/tmux/index.ts'
import { FileStateStore, type RunId } from '../../../src/state/index.ts'

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
    disableStepsView: true,
  })
  return { host, stderr }
}

// Variant that wires basePath + stateStore so the right-pane controller is
// created. U6's interactive path requires the controller: the runner pane is
// a hidden PTY in the scratch session, and `swapPane` is the only way to
// surface it. Tests that exercise `runInteractive` on the right pane go
// through this fixture.
async function buildHostWithController(tmux: FakeTmuxService) {
  const stderr = makeStderr()
  const fs = new FakeFsService()
  const basePath = path('/state')
  const stateStore = new FileStateStore({ fs, basePath })
  const host = await createTmuxHost({
    tmux,
    fs,
    processService: new FakeProcessService() as ProcessService,
    clock: new FakeClock(0),
    runId: 'r-2026-04-23-phased1' as RunId,
    workflowName: 'compound',
    stderr: stderr.stream,
    skipVersionCheck: true,
    disableStepsView: true,
    basePath,
    stateStore,
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

  // Regression: a previous version installed this backstop globally in
  // `src/cli/main.ts`, which fired on every exit path and emitted
  // `\x1b[?1049l` to a real TTY — Apple Terminal and iTerm2 treat that as a
  // screen-buffer toggle and wiped the user's visible terminal on
  // `--mode=single-pane` (and any other pre-host error). It now lives on
  // the two-pane host where it belongs; this test pins that contract.
  it('registers a hard-exit backstop that emits the DEC private-mode resets so tmux mode leaks survive `process.exit()`', async () => {
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%1'))

    let registeredHandler: (() => void) | undefined
    const writes: string[] = []
    const stdout = new Writable({
      write(chunk, _enc, cb) {
        writes.push(String(chunk))
        cb()
      },
    }) as unknown as NodeJS.WritableStream
    ;(stdout as unknown as { isTTY?: boolean }).isTTY = true

    await createTmuxHost({
      tmux,
      processService: new FakeProcessService() as ProcessService,
      clock: new FakeClock(0),
      runId: 'r-2026-04-23-phased1' as RunId,
      workflowName: 'compound',
      stderr: makeStderr().stream,
      skipVersionCheck: true,
      stdout,
      disableStepsView: true,
      installExitHandler: (h) => {
        registeredHandler = h
      },
    })

    expect(registeredHandler).toBeDefined()
    registeredHandler?.()
    const written = writes.join('')
    expect(written).toContain('\x1b[?1049l')
    expect(written).toContain('\x1b[?1006l')
  })
})

describe('TmuxHost.onRunnerEvent', () => {
  it('does not sendKeys to the right pane — runner bytes flow through the per-step tee (U5)', async () => {
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
    await host.teardown()

    // U5 invariant: no direct sendKeys onto the visible right pane for
    // transcript bytes. The hidden file-tail pane in scratch mirrors the
    // tee into the visible slot via swap-pane. (This test fixture has no
    // logger so the NULL tee swallows the bytes; the tee-content shape is
    // covered by `two-pane-mocked` and `right-pane-live-output` tests.)
    const rightSendKeys = tmux.recordedCalls.filter(
      (c) => c.method === 'sendKeys' && c.opts.target === paneId('%42'),
    )
    expect(rightSendKeys).toHaveLength(0)
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
  it('does not sendKeys the failure frame to the right pane — it is appended to the per-step tee (U5)', async () => {
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%42'))

    const { host } = await buildHost(tmux)

    host.onRunnerEvent({ kind: 'info', type: 'assistant', payload: {} }, stepName('plan'), [
      { kind: 'line', category: 'assistant', label: 'assistant>', body: 'thinking' },
    ])
    host.onLifecycleEvent({
      type: 'step:failed',
      stepName: stepName('plan'),
      error: new Error('boom'),
    })

    await host.teardown()

    // U5 invariant: failure frame is appended to the tee before
    // unregisterSource freezes the source. No sendKeys onto the visible
    // right pane. (The error-banner contract is covered by the controller
    // unit tests; this fixture has no controller because it omits
    // basePath + stateStore.)
    const rightSendKeys = tmux.recordedCalls.filter(
      (c) => c.method === 'sendKeys' && c.opts.target === paneId('%42'),
    )
    expect(rightSendKeys).toHaveLength(0)
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
  it('splits a scratch-session pane with runner argv + env + cwd, swaps it visible, and kills it on exit (U6)', async () => {
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    // First splitPane → visible right pane (%42). Second splitPane → the
    // hidden PTY pane in the scratch session (synthesized as %1 by the
    // FakeTmuxService counter).
    tmux.nextPaneId(paneId('%42'))

    const { host } = await buildHostWithController(tmux)

    // The runner argv, env, and cwd all flow into the scratch-session
    // splitPane call. `spawn.env` carries ANTHROPIC_API_KEY / OAuth
    // bootstrap vars / FORCE_COLOR=3; `spawn.cwd` becomes tmux's `-c <dir>`
    // flag — without it, the pane keeps tmux's default cwd of `/`.
    const spawnEnv = { ANTHROPIC_API_KEY: 'sk-test', FORCE_COLOR: '3' }
    const result = await host.runInteractive({
      argv: ['claude', '--resume', 'abc'],
      env: spawnEnv,
      cwd: path('/tmp'),
      stepName: stepName('review'),
    })

    expect(result.exitCode).toBe(0)

    // U6 invariant: NO `respawnPane` on the visible right pane. The
    // interactive runner lives in a hidden PTY pane in the scratch session;
    // the visible slot only ever sees `swapPane`.
    const rightRespawns = tmux.recordedCalls.filter(
      (c) => c.method === 'respawnPane' && c.opts.target === paneId('%42'),
    )
    expect(rightRespawns).toHaveLength(0)

    // The scratch-session splitPane carries the runner argv + env + cwd.
    // The first splitPane is the visible right pane (placeholder cat); the
    // second is the interactive PTY pane.
    const splits = tmux.recordedCalls.filter((c) => c.method === 'splitPane')
    const ptySplit = splits.find(
      (c) => c.method === 'splitPane' && 'argv' in c.opts && c.opts.argv?.[0] === 'claude',
    )
    if (ptySplit?.method !== 'splitPane') throw new Error('expected pty splitPane call')
    if (!('argv' in ptySplit.opts)) throw new Error('expected argv-form splitPane')
    expect(ptySplit.opts.argv).toEqual(['claude', '--resume', 'abc'])
    expect(ptySplit.opts.env).toEqual(spawnEnv)
    expect(ptySplit.opts.cwd).toBe(path('/tmp'))
    expect(ptySplit.opts.session).toBe('orch-scratch')

    // `showSource` issues a `swapPane` from the hidden pane into the visible
    // slot. There may be other swaps from controller setup or
    // unregisterSource (placeholder restore) — assert at least one swap
    // targeted the visible right pane id.
    const swaps = tmux.recordedCalls.filter((c) => c.method === 'swapPane')
    expect(swaps.length).toBeGreaterThanOrEqual(1)

    // We wait on the HIDDEN pane id's pane-exit channel, not the visible
    // right pane. The global pane-died hook keys on the dying pane's id,
    // and the runner dies in the hidden pane (which lives in the scratch
    // session). The hidden pane id is `%1` — the next synthesized id after
    // the visible right pane consumed `%42`.
    const waits = tmux.recordedCalls.filter((c) => c.method === 'waitFor')
    expect(waits).toHaveLength(1)
    const wait = waits[0]
    if (wait?.method !== 'waitFor') throw new Error('expected waitFor call')
    expect(wait.opts.channel).toBe('pane-exit-%1')
    expect(wait.opts.timeoutMs).toBeUndefined()

    // unregisterSource for `interactive` kills the hidden pane. The old
    // post-exit `respawnPane(['cat'])` restore is GONE — the visible
    // right pane never ran the runner argv, so there's nothing to clean
    // up on it.
    const kills = tmux.recordedCalls.filter((c) => c.method === 'killPane')
    expect(kills.length).toBeGreaterThanOrEqual(1)
  })

  it('omits timeoutMs on the pane-exit waitFor so an idle interactive agent never trips a default timeout', async () => {
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%42'))

    const { host } = await buildHostWithController(tmux)

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

    // Two sessions are torn down: the per-run scratch session FIRST so its
    // hidden panes can't outlive their swap target, then the visible orch
    // session.
    const killCalls = tmux.recordedCalls.filter((c) => c.method === 'killSession')
    expect(killCalls).toHaveLength(2)
    const sessions = killCalls.map((c) => (c.method === 'killSession' ? c.opts.session : ''))
    expect(sessions).toEqual(['orch-scratch', 'orch'])
  })

  it('is idempotent — a second teardown does not re-issue kill-session', async () => {
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%42'))

    const { host } = await buildHost(tmux)

    await host.teardown()
    await host.teardown()

    // Idempotent — orch-scratch + orch (no doubles on second teardown).
    const killCalls = tmux.recordedCalls.filter((c) => c.method === 'killSession')
    expect(killCalls).toHaveLength(2)
  })
})
