// triage: rewrite — swap-based replay visible outcome covered at Tier 1 (replay-shows-same-transcript-as-live). Keep controller-level fallback paths (refusal text, missing tee) Tier 1 cannot easily reach.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { Writable } from 'node:stream'
import { createRightPaneController } from '../../../../src/hosts/two-pane/pane-map/index.ts'
import { createPaneQueue } from '../../../../src/hosts/two-pane/pane-queue.ts'
import { toClaudeTranscriptLines } from '../../../../src/runners/index.ts'
import { FakeTmuxService, paneId, socketName } from '../../../../src/services/tmux/index.ts'
import { path as toPath } from '../../../../src/services/types.ts'
import {
  type RunId,
  type RunState,
  type StateStore,
  type StepEntry,
  runId as toRunId,
} from '../../../../src/state/index.ts'

// Integration coverage for the U8 swap-based replay path. Drives the real
// `createRightPaneController` against a `FakeTmuxService` and asserts that
// Enter on a past step registers a `file-tail` source on the scratch session
// and swaps the visible right pane to it — no `respawnPane` on the visible
// pane anywhere on the path.

const RUN_ID: RunId = toRunId('r-2026-05-06-100000-bb')
const RIGHT_PANE = paneId('%1')
const SCRATCH_SOCKET = socketName('orch-scratch-replay')
const SCRATCH_SESSION = { socket: SCRATCH_SOCKET, session: 'orch-scratch' }

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

function makeStore(steps: Record<string, StepEntry>): StateStore {
  const state: RunState = {
    schemaVersion: 5,
    id: RUN_ID,
    status: 'running',
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
    setArgs: async () => {
      throw new Error('not implemented')
    },
  }
}

function bufferStream(): NodeJS.WritableStream {
  return new Writable({
    write(_c, _e, cb) {
      cb()
    },
  }) as unknown as NodeJS.WritableStream
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 0))
  }
}

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp('/tmp/orch-rpc-test-')
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('right-pane-controller swap-based replay (U8)', () => {
  it('spawns tail -F over .replay/<step>.txt on scratch and swaps in for a commit step', async () => {
    const tmux = new FakeTmuxService()
    tmux.nextPaneId(paneId('%100'))
    const stateDir = `${tempDir}/state`
    await mkdir(stateDir, { recursive: true })

    const controller = createRightPaneController({
      tmux,
      socket: socketName('orch-int-1'),
      leftPaneId: paneId('%0'),
      rightPaneId: RIGHT_PANE,
      paneQueue: createPaneQueue(),
      stateStore: makeStore({
        'commit:c1': makeStep({ name: 'commit:c1', value: { sha: 'abc1234' } }),
      }),
      runId: RUN_ID,
      stateDir: toPath(stateDir),
      cwd: toPath(tempDir),
      env: {},
      stderr: bufferStream(),
      scratchSession: SCRATCH_SESSION,
    })

    controller.onIntent({ type: 'enter', stepName: 'commit:c1' })
    await flush()

    const splits = tmux.recordedCalls.filter((c) => c.method === 'splitPane')
    expect(splits).toHaveLength(1)
    const split = splits[0]
    if (split?.method !== 'splitPane') throw new Error('expected splitPane')
    expect(split.opts.session).toBe('orch-scratch')
    expect(split.opts.socket).toBe(SCRATCH_SOCKET)
    const argv = split.opts.argv
    if (argv === undefined) throw new Error('expected argv on splitPane')
    expect(argv[0]).toBe('tail')
    expect(argv[1]).toBe('-n')
    expect(argv[2]).toBe('5000')
    expect(argv[3]).toBe('-F')
    expect(argv[4]).toMatch(/\.replay\/commit:c1\.txt$/)

    const swaps = tmux.recordedCalls.filter((c) => c.method === 'swapPane')
    expect(swaps).toHaveLength(1)
    const swap = swaps[0]
    if (swap?.method !== 'swapPane') throw new Error('expected swapPane')
    expect(swap.opts.src).toBe(paneId('%100'))
    expect(swap.opts.dst).toBe(RIGHT_PANE)

    // No respawnPane on the visible right pane anywhere on the path.
    const respawns = tmux.recordedCalls.filter(
      (c) => c.method === 'respawnPane' && c.opts.target === RIGHT_PANE,
    )
    expect(respawns).toHaveLength(0)

    await controller.stop()
  })

  it('tails .replay/<step>.txt for an autonomous step with no persisted tee (JSON fallback)', async () => {
    const tmux = new FakeTmuxService()
    tmux.nextPaneId(paneId('%101'))
    const stateDir = `${tempDir}/state`
    await mkdir(`${stateDir}/steps`, { recursive: true })
    const transcriptRel = 'steps/plan.events.ndjson'
    await writeFile(
      `${stateDir}/${transcriptRel}`,
      `${JSON.stringify({ kind: 'info', type: 'assistant', payload: { text: 'integration-marker' } })}\n`,
      'utf8',
    )

    const controller = createRightPaneController({
      tmux,
      socket: socketName('orch-int-3'),
      leftPaneId: paneId('%0'),
      rightPaneId: RIGHT_PANE,
      paneQueue: createPaneQueue(),
      stateStore: makeStore({
        plan: makeStep({ name: 'plan', mode: 'autonomous', transcriptPath: transcriptRel }),
      }),
      runId: RUN_ID,
      stateDir: toPath(stateDir),
      cwd: toPath(tempDir),
      env: {},
      stderr: bufferStream(),
      scratchSession: SCRATCH_SESSION,
    })

    controller.onIntent({ type: 'enter', stepName: 'plan' })
    await flush()

    const splits = tmux.recordedCalls.filter((c) => c.method === 'splitPane')
    expect(splits).toHaveLength(1)
    const split = splits[0]
    if (split?.method !== 'splitPane') throw new Error('expected splitPane')
    const argv = split.opts.argv
    if (argv === undefined) throw new Error('expected argv on splitPane')
    expect(argv[0]).toBe('tail')
    // No logger configured → falls back to the JSON re-render at .replay/plan.txt.
    expect(argv[4]).toMatch(/\.replay\/plan\.txt$/)

    const replayBytes = await Bun.file(`${stateDir}/.replay/plan.txt`).text()
    expect(replayBytes).toContain('integration-marker')

    await controller.stop()
  })

  it('does not call newWindow / selectWindow / killWindow / respawnPane(rightPaneId) on any path', async () => {
    const tmux = new FakeTmuxService()
    tmux.nextPaneId(paneId('%201'))
    const stateDir = `${tempDir}/state`
    await mkdir(stateDir, { recursive: true })

    const controller = createRightPaneController({
      tmux,
      socket: socketName('orch-int-2'),
      leftPaneId: paneId('%0'),
      rightPaneId: RIGHT_PANE,
      paneQueue: createPaneQueue(),
      stateStore: makeStore({
        'commit:a': makeStep({ name: 'commit:a', value: { sha: 'a' } }),
        'commit:b': makeStep({ name: 'commit:b', value: { sha: 'b' } }),
      }),
      runId: RUN_ID,
      stateDir: toPath(stateDir),
      cwd: toPath(tempDir),
      env: {},
      stderr: bufferStream(),
      scratchSession: SCRATCH_SESSION,
    })

    tmux.nextPaneId(paneId('%201'))
    controller.onIntent({ type: 'enter', stepName: 'commit:a' })
    await flush()
    tmux.nextPaneId(paneId('%202'))
    controller.onIntent({ type: 'enter', stepName: 'commit:b' })
    await flush()
    controller.onIntent({ type: 'follow-live' })
    await flush()
    controller.onIntent({ type: 'quit' })
    await flush()

    const methods = tmux.recordedCalls.map((c) => c.method)
    expect(methods).not.toContain('newWindow')
    expect(methods).not.toContain('selectWindow')
    expect(methods).not.toContain('killWindow')
    const respawnsOnVisible = tmux.recordedCalls.filter(
      (c) => c.method === 'respawnPane' && c.opts.target === RIGHT_PANE,
    )
    expect(respawnsOnVisible).toHaveLength(0)

    await controller.stop()
  })

  it('renders Claude assistant text via toClaudeTranscriptLines when the host wires it as transcriptRenderer', async () => {
    // End-to-end lock for the regression that surfaced in completed-mode
    // ⏎-to-inspect: without `transcriptRenderer`, the replay file contains
    // raw `info:assistant {…json…}` lines. Wired with Claude's renderer, it
    // must contain the readable `assistant>` label seen in `orch logs`.
    const tmux = new FakeTmuxService()
    tmux.nextPaneId(paneId('%300'))
    const stateDir = `${tempDir}/state-claude-render`
    await mkdir(`${stateDir}/steps`, { recursive: true })
    const transcriptRel = 'steps/plan.events.ndjson'
    const claudeAssistantEvent = {
      kind: 'info',
      type: 'assistant',
      payload: {
        message: {
          model: 'claude-opus-4-7',
          content: [{ type: 'text', text: 'integration-claude-render' }],
        },
      },
    }
    await writeFile(
      `${stateDir}/${transcriptRel}`,
      `${JSON.stringify(claudeAssistantEvent)}\n`,
      'utf8',
    )

    const controller = createRightPaneController({
      tmux,
      socket: socketName('orch-int-claude'),
      leftPaneId: paneId('%0'),
      rightPaneId: RIGHT_PANE,
      paneQueue: createPaneQueue(),
      stateStore: makeStore({
        plan: makeStep({ name: 'plan', mode: 'autonomous', transcriptPath: transcriptRel }),
      }),
      runId: RUN_ID,
      stateDir: toPath(stateDir),
      cwd: toPath(tempDir),
      env: {},
      stderr: bufferStream(),
      transcriptRenderer: toClaudeTranscriptLines,
      scratchSession: SCRATCH_SESSION,
    })

    controller.onIntent({ type: 'enter', stepName: 'plan' })
    await flush()

    const replayBytes = await Bun.file(`${stateDir}/.replay/plan.txt`).text()
    expect(replayBytes).toContain('assistant>')
    expect(replayBytes).toContain('integration-claude-render')
    // JSON-fallback marker — the bug in completed-mode produced lines like
    // `[plan] · info:assistant {…huge-json…}`. With the Claude renderer
    // wired, this must never appear.
    expect(replayBytes).not.toContain('info:assistant')

    await controller.stop()
  })

  it('warm-caches the replay pane: re-Enter on the same step swaps without re-spawning', async () => {
    const tmux = new FakeTmuxService()
    tmux.nextPaneId(paneId('%150'))
    const stateDir = `${tempDir}/state`
    await mkdir(stateDir, { recursive: true })

    const controller = createRightPaneController({
      tmux,
      socket: socketName('orch-warm-cache'),
      leftPaneId: paneId('%0'),
      rightPaneId: RIGHT_PANE,
      paneQueue: createPaneQueue(),
      stateStore: makeStore({
        'commit:c1': makeStep({ name: 'commit:c1', value: { sha: 'aaa' } }),
        'commit:c2': makeStep({ name: 'commit:c2', value: { sha: 'bbb' } }),
      }),
      runId: RUN_ID,
      stateDir: toPath(stateDir),
      cwd: toPath(tempDir),
      env: {},
      stderr: bufferStream(),
      scratchSession: SCRATCH_SESSION,
    })

    controller.onIntent({ type: 'enter', stepName: 'commit:c1' })
    await flush()
    tmux.nextPaneId(paneId('%151'))
    controller.onIntent({ type: 'enter', stepName: 'commit:c2' })
    await flush()
    // Re-enter c1 — must reuse the warm-cached pane, no new splitPane.
    controller.onIntent({ type: 'enter', stepName: 'commit:c1' })
    await flush()

    const splits = tmux.recordedCalls.filter((c) => c.method === 'splitPane')
    expect(splits).toHaveLength(2)

    const swaps = tmux.recordedCalls.filter((c) => c.method === 'swapPane')
    // c1 swap-in, c2 swap-in, c1 swap-in (warm) — three total.
    expect(swaps).toHaveLength(3)

    await controller.stop()
  })

  it('swaps to placeholder on follow-live after a prior Enter when no live/rollup is registered', async () => {
    const tmux = new FakeTmuxService()
    tmux.nextPaneId(paneId('%400'))
    const stateDir = `${tempDir}/state`
    await mkdir(stateDir, { recursive: true })

    const controller = createRightPaneController({
      tmux,
      socket: socketName('orch-int-followlive'),
      leftPaneId: paneId('%0'),
      rightPaneId: RIGHT_PANE,
      paneQueue: createPaneQueue(),
      stateStore: makeStore({
        'commit:a': makeStep({ name: 'commit:a', value: { sha: 'aaa' } }),
      }),
      runId: RUN_ID,
      stateDir: toPath(stateDir),
      cwd: toPath(tempDir),
      env: {},
      stderr: bufferStream(),
      scratchSession: SCRATCH_SESSION,
    })

    // Register a placeholder so follow-live has something to swap to.
    tmux.nextPaneId(paneId('%399'))
    await controller.registerSource(
      { type: 'placeholder' },
      { kind: 'file-tail', path: toPath('/dev/null') },
    )

    tmux.nextPaneId(paneId('%400'))
    controller.onIntent({ type: 'enter', stepName: 'commit:a' })
    await flush()
    controller.onIntent({ type: 'follow-live' })
    await flush()

    // No respawnPane on the visible right pane.
    const respawns = tmux.recordedCalls.filter(
      (c) => c.method === 'respawnPane' && c.opts.target === RIGHT_PANE,
    )
    expect(respawns).toHaveLength(0)

    // Follow-live swap to placeholder must be present (last swap).
    const swaps = tmux.recordedCalls.filter((c) => c.method === 'swapPane')
    expect(swaps.length).toBeGreaterThanOrEqual(2)

    await controller.stop()
  })
})
