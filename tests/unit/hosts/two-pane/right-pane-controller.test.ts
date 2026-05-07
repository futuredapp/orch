import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { Writable } from 'node:stream'
import { createPaneQueue } from '../../../../src/hosts/two-pane/pane-queue.ts'
import { createRightPaneController } from '../../../../src/hosts/two-pane/right-pane-controller.ts'
import type { SessionLogger } from '../../../../src/observability/index.ts'
import { createNullSessionLogger } from '../../../../src/observability/index.ts'
import type { RunnerEvent, TranscriptLine } from '../../../../src/runners/index.ts'
import { FakeTmuxService, paneId, socketName } from '../../../../src/services/tmux/index.ts'
import { path as toPath } from '../../../../src/services/types.ts'
import {
  type PersistedWorkflowArgs,
  type RunId,
  type RunState,
  type StateStore,
  type StepEntry,
  runId as toRunId,
} from '../../../../src/state/index.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RUN_ID: RunId = toRunId('r-2026-05-05-100000-aa')
const RIGHT_PANE = paneId('%1')

function makeStore(
  steps: Record<string, StepEntry>,
  status: RunState['status'] = 'running',
): StateStore {
  const state: RunState = {
    schemaVersion: 5,
    id: RUN_ID,
    status,
    workflowName: 'demo',
    startedAt: 0,
    steps,
  }
  return {
    loadRun: async (rid) => (rid === RUN_ID ? state : undefined),
    saveStep: async () => {
      throw new Error('not implemented')
    },
    initRun: async () => {
      throw new Error('not implemented')
    },
    setStatus: async () => {
      throw new Error('not implemented')
    },
    setArgs: async (_rid: RunId, _args: PersistedWorkflowArgs) => {
      throw new Error('not implemented')
    },
  }
}

function bufferStream(): NodeJS.WritableStream {
  return new Writable({
    write(_chunk, _enc, cb) {
      cb()
    },
  }) as unknown as NodeJS.WritableStream
}

interface ControllerHarness {
  readonly tmux: FakeTmuxService
  readonly stateDir: string
  readonly stop: () => Promise<void>
  readonly onIntent: (
    i:
      | { readonly type: 'enter'; readonly stepName: string }
      | { readonly type: 'follow-live' }
      | { readonly type: 'quit' },
  ) => void
}

async function makeController(opts: {
  readonly tempDir: string
  readonly steps: Record<string, StepEntry>
}): Promise<ControllerHarness> {
  const tmux = new FakeTmuxService()
  const queue = createPaneQueue()
  const stateDir = `${opts.tempDir}/state`
  await mkdir(stateDir, { recursive: true })
  const controller = createRightPaneController({
    tmux,
    socket: socketName('orch-right-pane'),
    leftPaneId: paneId('%0'),
    rightPaneId: RIGHT_PANE,
    paneQueue: queue,
    stateStore: makeStore(opts.steps),
    runId: RUN_ID,
    stateDir: toPath(stateDir),
    cwd: toPath(opts.tempDir),
    env: {},
    stderr: bufferStream(),
  })
  return {
    tmux,
    stateDir,
    stop: () => controller.stop(),
    onIntent: controller.onIntent,
  }
}

async function makeControllerWithLogger(opts: {
  readonly tempDir: string
  readonly steps: Record<string, StepEntry>
  readonly logger: SessionLogger
}): Promise<ControllerHarness> {
  const tmux = new FakeTmuxService()
  const queue = createPaneQueue()
  const stateDir = `${opts.tempDir}/state-${Math.random().toString(36).slice(2, 8)}`
  await mkdir(stateDir, { recursive: true })
  const controller = createRightPaneController({
    tmux,
    socket: socketName('orch-right-pane-logged'),
    leftPaneId: paneId('%0'),
    rightPaneId: RIGHT_PANE,
    paneQueue: queue,
    stateStore: makeStore(opts.steps),
    runId: RUN_ID,
    stateDir: toPath(stateDir),
    cwd: toPath(opts.tempDir),
    env: {},
    stderr: bufferStream(),
    logger: opts.logger,
  })
  return {
    tmux,
    stateDir,
    stop: () => controller.stop(),
    onIntent: controller.onIntent,
  }
}

interface CapturedLog {
  readonly logger: SessionLogger
  readonly entries: Array<{ readonly category: string; readonly record: unknown }>
}

function capturingLogger(rid: RunId): CapturedLog {
  const base = createNullSessionLogger({ runId: rid })
  const entries: CapturedLog['entries'] = []
  const logger: SessionLogger = {
    ...base,
    append: async (category, record): Promise<void> => {
      entries.push({ category, record })
    },
  }
  return { logger, entries }
}

async function flush(): Promise<void> {
  // The controller dispatches enter intents via `void dispatchEnter(...)`; the
  // harness yields a few microtasks to let the scripted in-memory promises
  // settle before we assert. No fake timers — see the plan's "no fake timers
  // around Ink" rule (and the same rule applies to async controller paths
  // under test).
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 0))
  }
}

function makeStep(overrides: Partial<StepEntry> & Pick<StepEntry, 'name'>): StepEntry {
  return {
    name: overrides.name,
    value: overrides.value ?? null,
    startedAt: 1000,
    endedAt: 2000,
    artifacts: [],
    validations: [],
    transcriptEventCount: 0,
    transcriptTruncated: false,
    ...(overrides.mode !== undefined ? { mode: overrides.mode } : {}),
    ...(overrides.transcriptPath !== undefined ? { transcriptPath: overrides.transcriptPath } : {}),
  }
}

function findRespawnCalls(
  tmux: FakeTmuxService,
): ReadonlyArray<{ readonly argv: readonly string[]; readonly target: unknown }> {
  return tmux.recordedCalls
    .filter((c) => c.method === 'respawnPane')
    .map((c) => {
      if (c.method !== 'respawnPane') throw new Error('unreachable')
      return { argv: c.opts.argv, target: c.opts.target }
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp('/tmp/orch-rpc-test-')
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('right-pane-controller per-kind dispatch on enter', () => {
  it('respawns the right pane with cat <transcript-file> when Enter fires on an autonomous agent step', async () => {
    const transcriptRel = 'steps/plan.events.ndjson'
    const stateDir = `${tempDir}/state`
    await mkdir(`${stateDir}/steps`, { recursive: true })
    await writeFile(
      `${stateDir}/${transcriptRel}`,
      `${JSON.stringify({ kind: 'info', type: 'assistant', payload: { text: 'hello-world' } })}\n`,
      'utf8',
    )

    const tmux = new FakeTmuxService()
    const queue = createPaneQueue()
    const controller = createRightPaneController({
      tmux,
      socket: socketName('orch-rp-auton'),
      leftPaneId: paneId('%0'),
      rightPaneId: RIGHT_PANE,
      paneQueue: queue,
      stateStore: makeStore({
        plan: makeStep({ name: 'plan', mode: 'autonomous', transcriptPath: transcriptRel }),
      }),
      runId: RUN_ID,
      stateDir: toPath(stateDir),
      cwd: toPath(tempDir),
      env: {},
      stderr: bufferStream(),
    })

    controller.onIntent({ type: 'enter', stepName: 'plan' })
    await flush()

    const respawns = findRespawnCalls(tmux)
    expect(respawns).toHaveLength(1)
    const first = respawns[0]
    if (first === undefined) throw new Error('expected respawn')
    expect(first.target).toBe(RIGHT_PANE)
    expect(first.argv[0]).toBe('cat')
    expect(typeof first.argv[1]).toBe('string')
    expect(first.argv[1]).toMatch(/\.replay\/plan\.txt$/)
    // No window-1 lifecycle anywhere.
    expect(tmux.recordedCalls.some((c) => c.method === 'newWindow')).toBe(false)
    expect(tmux.recordedCalls.some((c) => c.method === 'selectWindow')).toBe(false)
    expect(tmux.recordedCalls.some((c) => c.method === 'killWindow')).toBe(false)

    // The replayed transcript content must reach the on-disk replay file.
    const replayBytes = await Bun.file(`${stateDir}/.replay/plan.txt`).text()
    expect(replayBytes).toContain('hello-world')

    await controller.stop()
  })

  it('forwards the supplied transcriptRenderer to renderTranscriptToString for autonomous-agent enter', async () => {
    const transcriptRel = 'steps/plan.events.ndjson'
    const stateDir = `${tempDir}/state-renderer`
    await mkdir(`${stateDir}/steps`, { recursive: true })
    await writeFile(
      `${stateDir}/${transcriptRel}`,
      `${JSON.stringify({ kind: 'info', type: 'assistant', payload: { text: 'whatever' } })}\n`,
      'utf8',
    )

    const stubRenderer = (_event: RunnerEvent): readonly TranscriptLine[] => [
      { kind: 'line', category: 'system', label: 'STUB-RENDER', body: 'wired-through' },
    ]

    const tmux = new FakeTmuxService()
    const queue = createPaneQueue()
    const controller = createRightPaneController({
      tmux,
      socket: socketName('orch-rp-renderer'),
      leftPaneId: paneId('%0'),
      rightPaneId: RIGHT_PANE,
      paneQueue: queue,
      stateStore: makeStore({
        plan: makeStep({ name: 'plan', mode: 'autonomous', transcriptPath: transcriptRel }),
      }),
      runId: RUN_ID,
      stateDir: toPath(stateDir),
      cwd: toPath(tempDir),
      env: {},
      stderr: bufferStream(),
      transcriptRenderer: stubRenderer,
    })

    controller.onIntent({ type: 'enter', stepName: 'plan' })
    await flush()

    const replayBytes = await Bun.file(`${stateDir}/.replay/plan.txt`).text()
    expect(replayBytes).toContain('STUB-RENDER')
    expect(replayBytes).toContain('wired-through')
    // JSON-fallback marker — must not appear when a renderer is supplied.
    // This locks the wiring against the regression that produced raw
    // `info:assistant {…json…}` lines in completed-mode inspect.
    expect(replayBytes).not.toContain('info:assistant')

    await controller.stop()
  })

  it('writes a refusal notice via cat <file> for an interactive agent step when no resume runner is wired', async () => {
    const harness = await makeController({
      tempDir,
      steps: {
        review: makeStep({ name: 'review', mode: 'interactive' }),
      },
    })

    harness.onIntent({ type: 'enter', stepName: 'review' })
    await flush()

    const respawns = findRespawnCalls(harness.tmux)
    expect(respawns).toHaveLength(1)
    const first = respawns[0]
    if (first === undefined) throw new Error('expected respawn')
    expect(first.target).toBe(RIGHT_PANE)
    expect(first.argv[0]).toBe('cat')

    const replayBytes = await Bun.file(`${harness.stateDir}/.replay/review.txt`).text()
    expect(replayBytes).toContain('resume unavailable')
    expect(replayBytes).toContain('review')

    await harness.stop()
  })

  it('respawns the right pane with cat <kind-details-file> for commit / worktree / ask kinds', async () => {
    const harness = await makeController({
      tempDir,
      steps: {
        'commit:c1': makeStep({ name: 'commit:c1', value: { sha: 'deadbee' } }),
        'worktree:w1': makeStep({
          name: 'worktree:w1',
          value: { path: '/tmp/wt', branch: 'feat', fromRef: 'main' },
        }),
        'ask:a1': makeStep({ name: 'ask:a1', value: { button: 'submit', name: 'martin' } }),
      },
    })

    harness.onIntent({ type: 'enter', stepName: 'commit:c1' })
    await flush()
    harness.onIntent({ type: 'enter', stepName: 'worktree:w1' })
    await flush()
    harness.onIntent({ type: 'enter', stepName: 'ask:a1' })
    await flush()

    const respawns = findRespawnCalls(harness.tmux)
    expect(respawns).toHaveLength(3)
    for (const call of respawns) {
      expect(call.target).toBe(RIGHT_PANE)
      expect(call.argv[0]).toBe('cat')
    }

    const commit = await Bun.file(`${harness.stateDir}/.replay/commit:c1.txt`).text()
    const worktree = await Bun.file(`${harness.stateDir}/.replay/worktree:w1.txt`).text()
    const ask = await Bun.file(`${harness.stateDir}/.replay/ask:a1.txt`).text()
    expect(commit).toContain('commit sha: deadbee')
    expect(worktree).toContain('path:    /tmp/wt')
    expect(ask).toContain('button: submit')

    await harness.stop()
  })

  it('respawns the right pane with cat <placeholder-file> for a command step with no captured log', async () => {
    const harness = await makeController({
      tempDir,
      steps: {
        'command:lint': makeStep({ name: 'command:lint' }),
      },
    })
    // The controller derives the pane log path from <stateDir>/logs/tmux/<rightPaneId>.log;
    // we deliberately do NOT create that file so the placeholder fires.

    harness.onIntent({ type: 'enter', stepName: 'command:lint' })
    await flush()

    const respawns = findRespawnCalls(harness.tmux)
    expect(respawns).toHaveLength(1)
    const first = respawns[0]
    if (first === undefined) throw new Error('expected respawn')
    expect(first.argv[0]).toBe('cat')
    // Placeholder uses the per-step replay file path (sanitized step name).
    expect(first.argv[1]).toMatch(/\.replay\/command:lint\.txt$/)

    const replayBytes = await Bun.file(`${harness.stateDir}/.replay/command:lint.txt`).text()
    expect(replayBytes).toContain('(no captured output')

    await harness.stop()
  })

  it('respawns the right pane with cat <pane-log-file> for a command step that has a captured log', async () => {
    const harness = await makeController({
      tempDir,
      steps: {
        'command:lint': makeStep({ name: 'command:lint' }),
      },
    })

    // The controller derives `<stateDir>/logs/tmux/<rightPaneId>.log`. Seed it.
    const captureDir = `${harness.stateDir}/logs/tmux`
    await mkdir(captureDir, { recursive: true })
    const captureFile = `${captureDir}/${RIGHT_PANE}.log`
    await writeFile(captureFile, 'captured-output\n', 'utf8')

    harness.onIntent({ type: 'enter', stepName: 'command:lint' })
    await flush()

    const respawns = findRespawnCalls(harness.tmux)
    expect(respawns).toHaveLength(1)
    const first = respawns[0]
    if (first === undefined) throw new Error('expected respawn')
    expect(first.argv[0]).toBe('cat')
    expect(first.argv[1]).toBe(captureFile)

    await harness.stop()
  })

  it('emits replay-pane-opened with the rightPaneId on a successful enter', async () => {
    const captured = capturingLogger(toRunId('r-2026-05-06-100001-aa'))
    const harness = await makeControllerWithLogger({
      tempDir,
      steps: { 'commit:a': makeStep({ name: 'commit:a', value: { sha: 'aaaaaaa' } }) },
      logger: captured.logger,
    })

    harness.onIntent({ type: 'enter', stepName: 'commit:a' })
    await flush()

    const opened = captured.entries
      .filter((e) => e.category === 'lifecycle')
      .map(
        (e) =>
          e.record as {
            readonly type?: string
            readonly stepName?: string
            readonly paneId?: string
          },
      )
      .find((r) => r.type === 'replay-pane-opened')
    expect(opened).toBeDefined()
    expect(opened?.stepName).toBe('commit:a')
    expect(opened?.paneId).toBe(String(RIGHT_PANE))

    await harness.stop()
  })

  it('emits replay-lookup-miss when Enter targets a step the state store does not know about', async () => {
    const captured = capturingLogger(toRunId('r-2026-05-06-100002-aa'))
    const harness = await makeControllerWithLogger({
      tempDir,
      steps: { 'commit:a': makeStep({ name: 'commit:a', value: { sha: 'aaaaaaa' } }) },
      logger: captured.logger,
    })

    harness.onIntent({ type: 'enter', stepName: 'commit:does-not-exist' })
    await flush()

    const miss = captured.entries.find(
      (e) =>
        e.category === 'lifecycle' &&
        (e.record as { readonly type?: string }).type === 'replay-lookup-miss',
    )
    expect(miss).toBeDefined()
    // Must NOT respawn the pane for the missing step.
    expect(harness.tmux.recordedCalls.some((c) => c.method === 'respawnPane')).toBe(false)

    await harness.stop()
  })

  it('emits replay-intent for every intent received', async () => {
    const captured = capturingLogger(toRunId('r-2026-05-06-100000-aa'))
    const harness = await makeControllerWithLogger({
      tempDir,
      steps: { 'commit:a': makeStep({ name: 'commit:a', value: { sha: 'aaaaaaa' } }) },
      logger: captured.logger,
    })

    harness.onIntent({ type: 'enter', stepName: 'commit:a' })
    harness.onIntent({ type: 'follow-live' })
    harness.onIntent({ type: 'quit' })
    await flush()

    const intents = captured.entries
      .filter((e) => e.category === 'lifecycle')
      .map(
        (e) => e.record as { readonly type?: string; readonly intent?: { readonly type: string } },
      )
      .filter((r) => r.type === 'replay-intent')
      .map((r) => r.intent?.type)
    expect(intents).toEqual(['enter', 'follow-live', 'quit'])

    await harness.stop()
  })

  it('does not call newWindow / selectWindow / killWindow on any path', async () => {
    const harness = await makeController({
      tempDir,
      steps: {
        'commit:a': makeStep({ name: 'commit:a', value: { sha: 'a' } }),
        'commit:b': makeStep({ name: 'commit:b', value: { sha: 'b' } }),
      },
    })

    harness.onIntent({ type: 'enter', stepName: 'commit:a' })
    await flush()
    harness.onIntent({ type: 'enter', stepName: 'commit:b' })
    await flush()
    harness.onIntent({ type: 'follow-live' })
    await flush()
    harness.onIntent({ type: 'quit' })
    await flush()

    const methods = harness.tmux.recordedCalls.map((c) => c.method)
    expect(methods).not.toContain('newWindow')
    expect(methods).not.toContain('selectWindow')
    expect(methods).not.toContain('killWindow')

    await harness.stop()
  })
})
