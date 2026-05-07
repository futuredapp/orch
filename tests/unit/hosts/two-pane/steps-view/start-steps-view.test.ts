// Unit tests for `startStepsView`.
//
// We drive the parent-side factory against:
//   - a FakeHost (records argv, returns a synthetic InteractiveResult immediately)
//   - a FakeTmuxService (records sendKeys / displayMessage)
//   - a real PaneQueue (so the failure-path enqueue actually runs)
//   - a real tempdir for the intent file (so the tail can read it back)
//
// The "child returned" path is the same one that fires for an unexpected exit
// in production — FakeHost has no way to keep `runInteractive` pending,
// so this test simulates the crash branch by definition.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import { Writable } from 'node:stream'
import { createPaneQueue } from '../../../../../src/hosts/two-pane/pane-queue.ts'
import { startStepsView } from '../../../../../src/hosts/two-pane/steps-view/index.ts'
import { createNullSessionLogger } from '../../../../../src/observability/index.ts'
import { FakeTmuxService, paneId, socketName } from '../../../../../src/services/tmux/index.ts'
import { path as toPath } from '../../../../../src/services/types.ts'
import type { RunId } from '../../../../../src/state/index.ts'
import { runId as toRunId } from '../../../../../src/state/index.ts'
import { createFakeHost } from '../../../../helpers/fake-host.ts'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp('/tmp/orch-stepsview-test-')
})

afterEach(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface Harness {
  readonly host: ReturnType<typeof createFakeHost>
  readonly tmux: FakeTmuxService
  readonly stderr: Writable
  readonly stderrText: () => string
  readonly logsAppended: Array<{ readonly category: string; readonly record: unknown }>
}

function makeHarness(): Harness {
  const host = createFakeHost({ mode: 'two-pane' })
  const tmux = new FakeTmuxService()
  const chunks: string[] = []
  const stderr = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk))
      cb()
    },
  })
  return {
    host,
    tmux,
    stderr,
    stderrText: () => chunks.join(''),
    logsAppended: [],
  }
}

const RID: RunId = toRunId('r-2026-04-10-458000-q8')

async function makeStateDir(): Promise<{ stateDir: string; intentsPath: string }> {
  const stateDir = `${tmpDir}/run`
  await fs.mkdir(stateDir, { recursive: true })
  const intentsPath = `${stateDir}/tui-intents.ndjson`
  return { stateDir, intentsPath }
}

describe('startStepsView', () => {
  it('records intentsStartOffset = 0 for a fresh state dir and spawns the runner script onto the left pane', async () => {
    const h = makeHarness()
    h.host.setInteractiveResult({ exitCode: 0, durationMs: 0 })
    const { stateDir } = await makeStateDir()

    const handle = await startStepsView({
      host: h.host,
      tmux: h.tmux,
      socket: socketName('orch-test'),
      leftPaneId: paneId('%0'),
      paneQueue: createPaneQueue(),
      stateDir: toPath(stateDir),
      basePath: toPath(tmpDir),
      runId: RID,
      workflowName: 'demo',
      cwd: toPath(tmpDir),
      env: {},
      stderr: h.stderr,
    })

    expect(handle.intentsStartOffset).toBe(0)
    expect(h.host.interactiveSpawns).toHaveLength(1)
    const spawn = h.host.interactiveSpawns[0]
    expect(spawn?.pane).toBe('left')
    expect(spawn?.argv[0]).toContain(process.execPath)
    expect(spawn?.argv).toContain('--opts')

    await handle.stop()
  })

  it('records intentsStartOffset to the size of the existing intents file so stale lines are not replayed', async () => {
    const h = makeHarness()
    h.host.setInteractiveResult({ exitCode: 0, durationMs: 0 })
    const { stateDir, intentsPath } = await makeStateDir()
    const stalePayload = `${JSON.stringify({ type: 'quit' })}\n`
    await fs.writeFile(intentsPath, stalePayload)

    const onIntent = (): void => {
      throw new Error('stale intent must not be dispatched')
    }
    const handle = await startStepsView({
      host: h.host,
      tmux: h.tmux,
      socket: socketName('orch-test'),
      leftPaneId: paneId('%0'),
      paneQueue: createPaneQueue(),
      stateDir: toPath(stateDir),
      basePath: toPath(tmpDir),
      runId: RID,
      workflowName: 'demo',
      cwd: toPath(tmpDir),
      env: {},
      stderr: h.stderr,
      onIntent,
    })

    expect(handle.intentsStartOffset).toBe(stalePayload.length)
    await wait(200) // give the tailer a beat — must NOT fire on stale content

    await handle.stop()
  })

  it('dispatches an intent appended after start through onIntent', async () => {
    const h = makeHarness()
    h.host.setInteractiveResult({ exitCode: 0, durationMs: 0 })
    const { stateDir, intentsPath } = await makeStateDir()
    const captured: string[] = []

    const handle = await startStepsView({
      host: h.host,
      tmux: h.tmux,
      socket: socketName('orch-test'),
      leftPaneId: paneId('%0'),
      paneQueue: createPaneQueue(),
      stateDir: toPath(stateDir),
      basePath: toPath(tmpDir),
      runId: RID,
      workflowName: 'demo',
      cwd: toPath(tmpDir),
      env: {},
      stderr: h.stderr,
      onIntent: (intent) => captured.push(intent.type),
    })

    await fs.appendFile(intentsPath, `${JSON.stringify({ type: 'follow-live' })}\n`)
    // Tail-ndjson polls every 250ms by default.
    await wait(500)

    expect(captured).toEqual(['follow-live'])
    await handle.stop()
  })

  it('logs a `tui-intent` lifecycle entry for each parsed intent received from the child', async () => {
    const h = makeHarness()
    h.host.setInteractiveResult({ exitCode: 0, durationMs: 0 })
    const { stateDir, intentsPath } = await makeStateDir()

    const lifecycleAppends: Array<{ readonly category: string; readonly record: unknown }> = []
    const baseLogger = createNullSessionLogger({ runId: RID })
    const wrappedLogger: typeof baseLogger = {
      ...baseLogger,
      append: async (category, record): Promise<void> => {
        lifecycleAppends.push({ category, record })
      },
    }

    const handle = await startStepsView({
      host: h.host,
      tmux: h.tmux,
      socket: socketName('orch-test'),
      leftPaneId: paneId('%0'),
      paneQueue: createPaneQueue(),
      stateDir: toPath(stateDir),
      basePath: toPath(tmpDir),
      runId: RID,
      workflowName: 'demo',
      cwd: toPath(tmpDir),
      env: {},
      stderr: h.stderr,
      logger: wrappedLogger,
      onIntent: () => {},
    })

    await fs.appendFile(intentsPath, `${JSON.stringify({ type: 'enter', stepName: 'plan' })}\n`)
    await wait(500)

    const intentLogs = lifecycleAppends.filter(
      (e) =>
        e.category === 'lifecycle' &&
        typeof e.record === 'object' &&
        e.record !== null &&
        (e.record as { type?: unknown }).type === 'tui-intent',
    )
    expect(intentLogs).toHaveLength(1)
    expect((intentLogs[0]?.record as { intent?: { stepName?: string } }).intent?.stepName).toBe(
      'plan',
    )

    await handle.stop()
  })

  it('logs a `tui-intent-parse-error` lifecycle entry when the intents file contains garbage', async () => {
    const h = makeHarness()
    h.host.setInteractiveResult({ exitCode: 0, durationMs: 0 })
    const { stateDir, intentsPath } = await makeStateDir()

    const lifecycleAppends: Array<{ readonly category: string; readonly record: unknown }> = []
    const baseLogger = createNullSessionLogger({ runId: RID })
    const wrappedLogger: typeof baseLogger = {
      ...baseLogger,
      append: async (category, record): Promise<void> => {
        lifecycleAppends.push({ category, record })
      },
    }

    const handle = await startStepsView({
      host: h.host,
      tmux: h.tmux,
      socket: socketName('orch-test'),
      leftPaneId: paneId('%0'),
      paneQueue: createPaneQueue(),
      stateDir: toPath(stateDir),
      basePath: toPath(tmpDir),
      runId: RID,
      workflowName: 'demo',
      cwd: toPath(tmpDir),
      env: {},
      stderr: h.stderr,
      logger: wrappedLogger,
    })

    await fs.appendFile(intentsPath, 'not-json\n')
    await wait(500)

    const errLogs = lifecycleAppends.filter(
      (e) =>
        e.category === 'lifecycle' &&
        typeof e.record === 'object' &&
        e.record !== null &&
        (e.record as { type?: unknown }).type === 'tui-intent-parse-error',
    )
    expect(errLogs).toHaveLength(1)

    await handle.stop()
  })

  it('writes the canonical "TUI unavailable" message via PaneQueue and logs tui-crashed on unexpected child exit', async () => {
    const h = makeHarness()
    // FakeHost.runInteractive returns immediately — same shape as the
    // unexpected-exit path we care about.
    h.host.setInteractiveResult({ exitCode: 1, durationMs: 7 })
    const { stateDir } = await makeStateDir()

    const logger = createNullSessionLogger({ runId: RID })
    const lifecycleAppends: Array<{ readonly category: string; readonly record: unknown }> = []
    const wrappedLogger: typeof logger = {
      ...logger,
      append: async (category, record): Promise<void> => {
        lifecycleAppends.push({ category, record })
      },
    }

    const handle = await startStepsView({
      host: h.host,
      tmux: h.tmux,
      socket: socketName('orch-test'),
      leftPaneId: paneId('%0'),
      paneQueue: createPaneQueue(),
      stateDir: toPath(stateDir),
      basePath: toPath(tmpDir),
      runId: RID,
      workflowName: 'demo',
      cwd: toPath(tmpDir),
      env: {},
      stderr: h.stderr,
      logger: wrappedLogger,
    })

    // Let the queued failure path drain.
    await wait(50)

    const crashedLog = lifecycleAppends.find(
      (e) =>
        e.category === 'lifecycle' &&
        typeof e.record === 'object' &&
        e.record !== null &&
        (e.record as { type?: unknown }).type === 'tui-crashed',
    )
    expect(crashedLog).toBeDefined()

    const sendKeys = h.tmux.recordedCalls.filter((c) => c.method === 'sendKeys')
    expect(sendKeys).toHaveLength(1)
    if (sendKeys[0]?.method === 'sendKeys') {
      expect(sendKeys[0].opts.keys.join('')).toContain('TUI unavailable')
    }

    await handle.stop()
  })
})
