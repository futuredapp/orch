import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { Writable } from 'node:stream'
import { createPaneQueue } from '../../../../src/hosts/two-pane/pane-queue.ts'
import { createRightPaneController } from '../../../../src/hosts/two-pane/right-pane-controller.ts'
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

// Integration coverage: drive the real `createRightPaneController` against a
// `FakeTmuxService` recorder and assert the contract is `respawnPane(rightPaneId,
// ['cat', <file>])` end-to-end. The Direction-B redesign drops the window-1
// lifecycle entirely — we explicitly assert no `newWindow` / `selectWindow` /
// `killWindow` are issued by any path.

const RUN_ID: RunId = toRunId('r-2026-05-06-100000-bb')
const RIGHT_PANE = paneId('%1')

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

describe('right-pane-controller in-place replay (Direction B)', () => {
  it('drives a single respawnPane(rightPaneId, [cat, <file>]) on enter for a commit step', async () => {
    const tmux = new FakeTmuxService()
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
    })

    controller.onIntent({ type: 'enter', stepName: 'commit:c1' })
    await flush()

    const respawns = tmux.recordedCalls.filter((c) => c.method === 'respawnPane')
    expect(respawns).toHaveLength(1)
    const first = respawns[0]
    if (first?.method !== 'respawnPane') throw new Error('expected respawnPane')
    expect(first.opts.target).toBe(RIGHT_PANE)
    expect(first.opts.argv[0]).toBe('cat')
    expect(first.opts.argv[1]).toMatch(/\.replay\/commit:c1\.txt$/)
    expect(first.opts.killRunning).toBe(true)

    await controller.stop()
  })

  it('respawns rightPaneId with cat <transcript-file> for an enter on an autonomous step', async () => {
    const tmux = new FakeTmuxService()
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
    })

    controller.onIntent({ type: 'enter', stepName: 'plan' })
    await flush()

    const respawns = tmux.recordedCalls.filter((c) => c.method === 'respawnPane')
    expect(respawns).toHaveLength(1)
    const first = respawns[0]
    if (first?.method !== 'respawnPane') throw new Error('expected respawnPane')
    expect(first.opts.target).toBe(RIGHT_PANE)
    expect(first.opts.argv[0]).toBe('cat')
    expect(first.opts.argv[1]).toMatch(/\.replay\/plan\.txt$/)

    const replayBytes = await Bun.file(`${stateDir}/.replay/plan.txt`).text()
    expect(replayBytes).toContain('integration-marker')

    await controller.stop()
  })

  it('does not call newWindow / selectWindow / killWindow on any path', async () => {
    const tmux = new FakeTmuxService()
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
    })

    controller.onIntent({ type: 'enter', stepName: 'commit:a' })
    await flush()
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

    await controller.stop()
  })

  it('renders Claude assistant text via toClaudeTranscriptLines when the host wires it as transcriptRenderer', async () => {
    // End-to-end lock for the regression that surfaced in completed-mode
    // ⏎-to-inspect: without `transcriptRenderer`, the replay file contains
    // raw `info:assistant {…json…}` lines. Wired with Claude's renderer, it
    // must contain the readable `assistant>` label seen in `orch logs`.
    const tmux = new FakeTmuxService()
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

  it('respawns rightPaneId with the cat placeholder on follow-live', async () => {
    const tmux = new FakeTmuxService()
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
    })

    controller.onIntent({ type: 'enter', stepName: 'commit:a' })
    await flush()
    controller.onIntent({ type: 'follow-live' })
    await flush()

    const respawns = tmux.recordedCalls.filter((c) => c.method === 'respawnPane')
    expect(respawns).toHaveLength(2)
    const last = respawns.at(-1)
    if (last?.method !== 'respawnPane') throw new Error('expected respawn')
    expect(last.opts.target).toBe(RIGHT_PANE)
    expect(last.opts.argv).toEqual(['cat'])
    expect(last.opts.killRunning).toBe(true)

    await controller.stop()
  })
})
