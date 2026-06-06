// MIGRATED → tests-new/unit/hosts/tmux-host.test.ts (parent U12) — relocated verbatim (import paths only); kept skipped on disk (D2).
// Unit tests for TmuxHost — drives the host with a FakeTmuxService and asserts
// the recorded tmux command sequence. No real tmux server is started.

import { describe, expect, it } from 'bun:test'
import { Writable } from 'node:stream'
import { stepName } from '../../../src/core/types.ts'
import { createTmuxHost } from '../../../src/hosts/index.ts'
import {
  createNullSessionLogger,
  type JsonObject,
  type SessionLogger,
} from '../../../src/observability/index.ts'
import type { RunnerEvent } from '../../../src/runners/index.ts'
import { FakeFsService } from '../../../src/services/fs/index.ts'
import {
  FakeClock,
  FakeProcessService,
  type ProcessService,
  path,
} from '../../../src/services/index.ts'
import {
  FakeTmuxService,
  paneId,
  type SocketName,
  socketName,
  TmuxCommandError,
  type WaitForOptions,
} from '../../../src/services/tmux/index.ts'
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
async function buildHostWithController(tmux: FakeTmuxService, logger?: SessionLogger) {
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
    ...(logger !== undefined ? { logger } : {}),
  })
  return { host, stderr }
}

function makeCaptureLogger(runId: RunId): {
  readonly logger: SessionLogger
  readonly records: Array<{ readonly category: string; readonly record: JsonObject }>
} {
  const base = createNullSessionLogger({ runId })
  const records: Array<{ readonly category: string; readonly record: JsonObject }> = []
  return {
    records,
    logger: {
      ...base,
      append: async (category, record): Promise<void> => {
        records.push({ category, record })
      },
    },
  }
}

// Logger variant with `logsDir` set so `teePathFor` returns a non-null path.
// Used by tests that exercise the host's `step:start` → `registerSource` path,
// which the host short-circuits when there is no logsDir.
function makeLoggerWithLogsDir(runId: RunId): SessionLogger {
  const base = createNullSessionLogger({ runId })
  return { ...base, logsDir: path('/logs') }
}

class WaitForSessionLostTmuxService extends FakeTmuxService {
  override async waitFor(opts: WaitForOptions): Promise<void> {
    await super.waitFor(opts)
    throw new TmuxCommandError(
      1,
      `error connecting to /private/tmp/tmux-501/${opts.socket} (No such file or directory)`,
      `tmux wait-for failed (exit 1): error connecting to /private/tmp/tmux-501/${opts.socket} (No such file or directory)`,
    )
  }
}

describe.skip('createTmuxHost setup', () => {
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

  it('routes an unhandled rejection to the lifecycle log instead of bleeding the stack to fd-2', async () => {
    // Backstop for the fd-2 bleed (incident r-2026-05-25-171216-nu): an escaped
    // rejection must never reach Node's default handler, which writes to the
    // TTY shared with the attached tmux client. The host installs an
    // `unhandledRejection` handler that logs to the session lifecycle file and
    // swallows the rejection. Here we capture the registered handler via the
    // injection seam and assert it logs without writing a single byte to fd-2.
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%1'))
    const capture = makeCaptureLogger('r-2026-04-23-phased1' as RunId)
    const stderr = makeStderr()

    let registeredRejectionHandler: ((reason: unknown) => void) | undefined
    await createTmuxHost({
      tmux,
      processService: new FakeProcessService() as ProcessService,
      clock: new FakeClock(0),
      runId: 'r-2026-04-23-phased1' as RunId,
      workflowName: 'compound',
      stderr: stderr.stream,
      skipVersionCheck: true,
      disableStepsView: true,
      logger: capture.logger,
      installRejectionHandler: (h) => {
        registeredRejectionHandler = h
      },
    })

    expect(registeredRejectionHandler).toBeDefined()
    registeredRejectionHandler?.(new Error("swap-pane failed: can't find pane: %29"))
    await new Promise((r) => setTimeout(r, 0))

    const suppressed = capture.records.find(
      (e) => e.category === 'lifecycle' && e.record.type === 'unhandled-rejection-suppressed',
    )
    expect(suppressed).toBeDefined()
    expect(String(suppressed?.record.errorMessage)).toContain("can't find pane")
    // The whole point: nothing reaches the shared TTY.
    expect(stderr.text()).toBe('')
  })
})

describe.skip('TmuxHost.onRunnerEvent', () => {
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

describe.skip('TmuxHost.onLifecycleEvent — step:failed', () => {
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

describe.skip('TmuxHost.onLifecycleEvent — step:parallel-branch-update', () => {
  it('does not fan rollup bytes onto the right pane (U7 invariant — rollup lives in the _rollup tee)', async () => {
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%42'))

    const { host } = await buildHost(tmux)

    host.onLifecycleEvent({ type: 'step:parallel-start', blockId: 0 })
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
    host.onLifecycleEvent({ type: 'step:parallel-complete', blockId: 0 })

    await host.teardown()

    // U7: rollup payloads no longer reach the visible right pane via
    // `sendKeys`. They land in the `_rollup` meta tee; the scratch-session
    // hidden pane tails the tee and reaches the visible slot via `swapPane`.
    // The integration test in tests/integration/hosts/two-pane/tmux-host-
    // rollup-pane-map.integration.test.ts covers the tee + register/unregister
    // path; here we only guard the right-pane invariant.
    const rightSendKeys = tmux.recordedCalls.filter(
      (c) => c.method === 'sendKeys' && c.opts.target === paneId('%42'),
    )
    expect(rightSendKeys).toHaveLength(0)
  })
})

describe.skip('TmuxHost.runInteractive', () => {
  it('logs right-pane interactive pane lifecycle diagnostics', async () => {
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%42'))
    const capture = makeCaptureLogger('r-2026-04-23-phased1' as RunId)

    const { host } = await buildHostWithController(tmux, capture.logger)

    await host.runInteractive({
      argv: ['claude', '--resume', 'abc'],
      env: {},
      cwd: path('/tmp'),
      stepName: stepName('review'),
    })

    const lifecycleTypes = capture.records
      .filter((r) => r.category === 'lifecycle')
      .map((r) => r.record.type)

    expect(lifecycleTypes).toContain('interactive-start')
    expect(lifecycleTypes).toContain('interactive-register-start')
    expect(lifecycleTypes).toContain('pane-spawn-start')
    expect(lifecycleTypes).toContain('interactive-hidden-pane-ready')
    expect(lifecycleTypes).toContain('right-pane-swap-start')
    expect(lifecycleTypes).toContain('interactive-wait-start')
    expect(lifecycleTypes).toContain('interactive-wait-complete')
    expect(lifecycleTypes).toContain('interactive-unregister-complete')

    await host.teardown()
  })

  it('logs left-pane wait failures so fake clean TUI exits are diagnosable', async () => {
    const tmux = new WaitForSessionLostTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%42'))
    const capture = makeCaptureLogger('r-2026-04-23-phased1' as RunId)
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
      logger: capture.logger,
    })

    const result = await host.runInteractive({
      argv: ['bun', 'steps-view-runner.tsx'],
      env: {},
      cwd: path('/tmp'),
      stepName: stepName('tui-steps-view'),
      pane: 'left',
    })

    expect(result.exitCode).toBe(0)
    const failed = capture.records.find(
      (r) => r.category === 'lifecycle' && r.record.type === 'interactive-wait-failed',
    )
    expect(failed?.record.stepName).toBe('tui-steps-view')
    expect(failed?.record.pane).toBe('left')
    expect(failed?.record.isSessionLost).toBe(true)
    expect(failed?.record.tmuxStderr).toContain('No such file or directory')

    await host.teardown()
  })

  it('creates a per-source tmux session with the runner argv + env + cwd, swaps it visible, and kills the session on exit (U4)', async () => {
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    // splitPane returns %42 for the visible right pane.
    tmux.nextPaneId(paneId('%42'))
    // The `createSession` script is FIFO. The first createSession is the
    // bootstrap `orch` session (eats %50 — value is discarded). The second
    // is the per-source PTY pane (%77) whose id drives the pane-exit channel.
    tmux.nextCreateSessionPaneId(paneId('%50'))
    tmux.nextCreateSessionPaneId(paneId('%77'))

    const { host } = await buildHostWithController(tmux)

    // The runner argv, env, and cwd all flow into the per-source createSession
    // call. `spawn.env` carries ANTHROPIC_API_KEY / OAuth bootstrap vars /
    // FORCE_COLOR=3; `spawn.cwd` becomes tmux's `-c <dir>` flag — without it,
    // the pane keeps tmux's default cwd of `/`.
    const spawnEnv = { ANTHROPIC_API_KEY: 'sk-test', FORCE_COLOR: '3' }
    const result = await host.runInteractive({
      argv: ['claude', '--resume', 'abc'],
      env: spawnEnv,
      cwd: path('/tmp'),
      stepName: stepName('review'),
    })

    expect(result.exitCode).toBe(0)

    // U4 invariant: NO `respawnPane` on the visible right pane. The
    // interactive runner lives in a hidden PTY pane in its own per-source
    // session; the visible slot only ever sees `swapPane`.
    const rightRespawns = tmux.recordedCalls.filter(
      (c) => c.method === 'respawnPane' && c.opts.target === paneId('%42'),
    )
    expect(rightRespawns).toHaveLength(0)

    // U4 invariant: the interactive PTY pane is created via `createSession`
    // with the sanitized per-source name, NOT via `splitPane` against a
    // shared substrate. The first `createSession` is the bootstrap `orch`
    // session; the per-source call carries the runner argv + env + cwd.
    const createSessions = tmux.recordedCalls.filter((c) => c.method === 'createSession')
    const ptyCreate = createSessions.find(
      (c) => c.method === 'createSession' && c.opts.session === 'orch-src-interactive-review',
    )
    if (ptyCreate?.method !== 'createSession') {
      throw new Error('expected per-source createSession for interactive review')
    }
    expect(ptyCreate.opts.command).toEqual(['claude', '--resume', 'abc'])
    expect(ptyCreate.opts.env).toEqual(spawnEnv)
    expect(ptyCreate.opts.cwd).toBe(path('/tmp'))

    // The interactive PTY pane no longer arrives via `splitPane`. We allow
    // exactly one `splitPane` — the visible right pane bootstrap.
    const splits = tmux.recordedCalls.filter((c) => c.method === 'splitPane')
    expect(splits).toHaveLength(1)

    // `showSource` issues a `swapPane` from the hidden pane into the visible
    // slot. There may be other swaps from controller setup or
    // unregisterSource (placeholder restore) — assert at least one swap
    // happened.
    const swaps = tmux.recordedCalls.filter((c) => c.method === 'swapPane')
    expect(swaps.length).toBeGreaterThanOrEqual(1)

    // We wait on the HIDDEN pane id's pane-exit channel, not the visible
    // right pane. The global pane-died hook keys on the dying pane's id,
    // and the runner dies in the hidden pane (which lives in its own
    // per-source session). The hidden pane id is `%77` — scripted above.
    const waits = tmux.recordedCalls.filter((c) => c.method === 'waitFor')
    expect(waits).toHaveLength(1)
    const wait = waits[0]
    if (wait?.method !== 'waitFor') throw new Error('expected waitFor call')
    expect(wait.opts.channel).toBe('pane-exit-%77')
    expect(wait.opts.timeoutMs).toBeUndefined()

    // unregisterSource for `interactive` kills the per-source SESSION
    // (which destroys the hidden pane with it). The old `killPane` is gone.
    const sessionKills = tmux.recordedCalls.filter(
      (c) => c.method === 'killSession' && c.opts.session === 'orch-src-interactive-review',
    )
    expect(sessionKills).toHaveLength(1)
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

describe.skip('TmuxHost.teardown', () => {
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

  it('kills the visible orch session on teardown — no shared substrate session is created at boot (U4)', async () => {
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%42'))

    const { host } = await buildHost(tmux)

    // U4: no controller is wired in this fixture (no basePath + stateStore),
    // so no per-source sessions exist. Boot creates exactly one session
    // (`orch`); no `orch-src-*` or legacy `orch-scratch` is created.
    const createCalls = tmux.recordedCalls.filter((c) => c.method === 'createSession')
    const createdSessions = createCalls.map((c) =>
      c.method === 'createSession' ? c.opts.session : '',
    )
    expect(createdSessions).toEqual(['orch'])

    await host.teardown()

    // Only the visible `orch` session is torn down — no per-source sessions
    // exist when the controller is absent, and the legacy `orch-scratch`
    // session is gone for good.
    const killCalls = tmux.recordedCalls.filter((c) => c.method === 'killSession')
    expect(killCalls).toHaveLength(1)
    const sessions = killCalls.map((c) => (c.method === 'killSession' ? c.opts.session : ''))
    expect(sessions).toEqual(['orch'])
  })

  it('is idempotent — a second teardown does not re-issue kill-session', async () => {
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%42'))

    const { host } = await buildHost(tmux)

    await host.teardown()
    await host.teardown()

    // Idempotent — only the visible orch session is killed; no doubles on
    // the second teardown.
    const killCalls = tmux.recordedCalls.filter((c) => c.method === 'killSession')
    expect(killCalls).toHaveLength(1)
  })

  it('drains every per-source session before killing the visible orch session (U4)', async () => {
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%42'))

    // teePathFor() returns null when the logger has no logsDir; without a
    // path the host's `step:start` short-circuits to an info banner instead
    // of calling controller.registerSource. Wire a logger with logsDir so
    // the host actually creates per-source sessions for these steps.
    const logger = makeLoggerWithLogsDir('r-2026-04-23-phased1' as RunId)
    const { host } = await buildHostWithController(tmux, logger)

    // Drive three live sources through the host's lifecycle hook. The
    // controller creates one per-source session per registerSource(...) call.
    host.onLifecycleEvent({ type: 'step:start', stepName: stepName('plan'), mode: 'autonomous' })
    host.onLifecycleEvent({ type: 'step:start', stepName: stepName('build'), mode: 'autonomous' })
    host.onLifecycleEvent({ type: 'step:start', stepName: stepName('check'), mode: 'autonomous' })

    // Let the fire-and-forget controller.registerSource(...) chains settle
    // before we tear down — otherwise teardown can race the in-flight
    // registrations and produce a non-deterministic kill order.
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    await host.teardown()

    const killCalls = tmux.recordedCalls.filter((c) => c.method === 'killSession')
    const killedSessions = killCalls.map((c) => (c.method === 'killSession' ? c.opts.session : ''))

    // Every per-source session kill must land BEFORE the visible orch kill —
    // the order among the per-source kills is not asserted (parallel work
    // is allowed) but the orch kill must be last.
    expect(killedSessions[killedSessions.length - 1]).toBe('orch')
    const perSourceKills = killedSessions.slice(0, -1)
    expect(perSourceKills).toContain('orch-src-live-plan')
    expect(perSourceKills).toContain('orch-src-live-build')
    expect(perSourceKills).toContain('orch-src-live-check')
  })

  it('still kills the visible orch session when controller.teardownSessions() fails (U4)', async () => {
    class FailTeardownTmux extends FakeTmuxService {
      override async killSession(
        opts: import('../../../src/services/tmux/index.ts').KillSessionOptions,
      ): Promise<void> {
        if (opts.session.startsWith('orch-src-')) {
          throw new TmuxCommandError(
            1,
            'simulated per-source kill failure',
            'tmux kill-session failed (exit 1): simulated per-source kill failure',
          )
        }
        await super.killSession(opts)
      }
    }
    const tmux = new FailTeardownTmux()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%42'))

    const logger = makeLoggerWithLogsDir('r-2026-04-23-phased1' as RunId)
    const { host } = await buildHostWithController(tmux, logger)
    host.onLifecycleEvent({ type: 'step:start', stepName: stepName('plan'), mode: 'autonomous' })
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    await host.teardown()

    // Even though every per-source killSession threw, the visible orch
    // session must still be reaped — the existing try/catch shape preserves
    // the contract.
    const killCalls = tmux.recordedCalls.filter((c) => c.method === 'killSession')
    const sessions = killCalls.map((c) => (c.method === 'killSession' ? c.opts.session : ''))
    expect(sessions).toContain('orch')
  })

  // Regression: a second concurrent teardown call (e.g. back-to-back SIGINTs
  // routed through `executeWithAttach`'s signal handler) used to short-circuit
  // on the inner `torndown` flag and resolve immediately, while the first
  // call's `killSession` was still in flight. The signal handler's
  // `.finally(process.exit)` then fired before tmux was actually killed,
  // leaving the session alive after orch exited. This pins the latch
  // contract: both callers await the same underlying cleanup.
  it('latches concurrent teardown calls — second caller waits for kill-session to complete', async () => {
    let releaseKill: (() => void) | undefined
    const killGate = new Promise<void>((resolve) => {
      releaseKill = resolve
    })
    class GatedKillTmuxService extends FakeTmuxService {
      override async killSession(
        opts: import('../../../src/services/tmux/index.ts').KillSessionOptions,
      ): Promise<void> {
        await killGate
        await super.killSession(opts)
      }
    }
    const tmux = new GatedKillTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%42'))

    const { host } = await buildHost(tmux)

    let firstResolved = false
    let secondResolved = false
    const first = host.teardown().then(() => {
      firstResolved = true
    })
    const second = host.teardown().then(() => {
      secondResolved = true
    })

    // Let any microtasks settle: with the latch, neither call may resolve
    // until killSession (gated below) actually returns.
    await new Promise((r) => setTimeout(r, 20))
    expect(firstResolved).toBe(false)
    expect(secondResolved).toBe(false)

    releaseKill?.()
    await Promise.all([first, second])

    expect(firstResolved).toBe(true)
    expect(secondResolved).toBe(true)
    // Still idempotent — kill-session is issued at most twice (scratch + main)
    // across all concurrent callers.
    const killCalls = tmux.recordedCalls.filter((c) => c.method === 'killSession')
    expect(killCalls.length).toBeLessThanOrEqual(2)
  })

  // Regression: real-world symptom on macOS — after `bunx orch run …`
  // exits, the user's terminal is left with the shell prompt redrawn in
  // the middle of the screen, the rest blank below, and the success
  // summary `Workflow … completed.` missing entirely.
  //
  // Behavioral contract this test pins: once `teardown()` has returned,
  // the host has handed the outer TTY back to the CLI. The CLI then
  // writes the success/failure summary and exits. The host must not
  // touch the TTY again on this graceful path — its hard-exit backstop
  // is a safety net for the crash path where teardown never ran, NOT a
  // second emission stapled onto a clean shutdown. (Why this matters in
  // practice: Apple Terminal and iTerm2 treat the alt-screen-exit byte
  // as a screen-buffer toggle, so any redundant emission after a clean
  // teardown switches INTO the alt-screen and buries whatever the CLI
  // wrote in between — hence the missing summary in the screenshot.)
  it('does not touch the outer TTY again after teardown returns on the graceful exit path', async () => {
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%1'))

    const writes: string[] = []
    const stdout = new Writable({
      write(chunk, _enc, cb) {
        writes.push(String(chunk))
        cb()
      },
    }) as unknown as NodeJS.WritableStream
    ;(stdout as unknown as { isTTY?: boolean }).isTTY = true

    let registeredHandler: (() => void) | undefined
    const host = await createTmuxHost({
      tmux,
      processService: new FakeProcessService() as ProcessService,
      clock: new FakeClock(0),
      runId: 'r-2026-05-18-altreset' as RunId,
      workflowName: 'compound',
      stderr: makeStderr().stream,
      skipVersionCheck: true,
      stdout,
      disableStepsView: true,
      installExitHandler: (h) => {
        registeredHandler = h
      },
    })

    await host.teardown()
    const bytesAfterTeardown = writes.join('').length

    // Simulate `process.exit(...)` following a graceful teardown. The
    // contract is "no further writes" — not "fewer of byte X" — so the
    // assertion compares total bytes written, not the count of any
    // specific escape sequence.
    expect(registeredHandler).toBeDefined()
    registeredHandler?.()

    const bytesAfterExit = writes.join('').length
    expect(bytesAfterExit).toBe(bytesAfterTeardown)
  })
})

describe.skip('createTmuxHost socket resolution', () => {
  // Collect every socket the host named across its recorded tmux calls. Every
  // call that talks to tmux carries a `socket`; the set should be a singleton.
  function socketsTouched(tmux: FakeTmuxService): Set<string> {
    const sockets = new Set<string>()
    for (const call of tmux.recordedCalls) {
      const socket = (call.opts as { socket?: unknown }).socket
      if (typeof socket === 'string') sockets.add(socket)
    }
    return sockets
  }

  function paneDiedCommand(tmux: FakeTmuxService): string | undefined {
    const hook = tmux.recordedCalls.find(
      (c) => c.method === 'setHook' && /pane-died/.test(JSON.stringify(c.opts)),
    )
    return hook?.method === 'setHook' ? hook.opts.command : undefined
  }

  async function buildHostWith(opts: { socket?: SocketName }): Promise<FakeTmuxService> {
    const tmux = new FakeTmuxService()
    tmux.setListPanesResult(['%0'])
    tmux.nextPaneId(paneId('%1'))
    const stderr = makeStderr()
    await createTmuxHost({
      tmux,
      processService: new FakeProcessService() as ProcessService,
      clock: new FakeClock(0),
      runId: 'r-2026-04-23-phased1' as RunId,
      workflowName: 'compound',
      stderr: stderr.stream,
      skipVersionCheck: true,
      disableStepsView: true,
      ...(opts.socket !== undefined ? { socket: opts.socket } : {}),
    })
    return tmux
  }

  it('derives the socket as orch-${runId} when no socket is supplied', async () => {
    const tmux = await buildHostWith({})

    expect([...socketsTouched(tmux)]).toEqual(['orch-r-2026-04-23-phased1'])
    expect(paneDiedCommand(tmux)).toContain('tmux -L orch-r-2026-04-23-phased1')
  })

  it('routes every tmux call through an explicit socket override when supplied', async () => {
    const tmux = await buildHostWith({ socket: socketName('orch-test-99-abcd') })

    expect([...socketsTouched(tmux)]).toEqual(['orch-test-99-abcd'])
  })

  it('embeds the provided socket in the pane-died hook, not orch-${runId}', async () => {
    const tmux = await buildHostWith({ socket: socketName('orch-test-99-abcd') })

    const command = paneDiedCommand(tmux)
    expect(command).toContain('tmux -L orch-test-99-abcd')
    expect(command).not.toContain('orch-r-2026-04-23-phased1')
  })

  it('functions when socket diverges from runId — session setup and right-pane split still run', async () => {
    const tmux = await buildHostWith({ socket: socketName('orch-test-99-abcd') })

    const methods = tmux.recordedCalls.map((c) => c.method)
    expect(methods).toContain('createSession')
    expect(methods).toContain('splitPane')
    // runId still drives session naming; only the socket decoupled.
    const create = tmux.recordedCalls.find((c) => c.method === 'createSession')
    if (create?.method !== 'createSession') throw new Error('expected createSession call')
    expect(String(create.opts.socket)).toBe('orch-test-99-abcd')
  })
})
