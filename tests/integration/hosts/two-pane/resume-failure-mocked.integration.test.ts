// Integration coverage for the resume failure path under the U8 swap-based
// model. When `resumeCommand` throws, the controller writes the canonical
// `"resume failed — press f to return..."` footer to the per-step `.replay/`
// file and registers a `file-tail` source over it on the scratch session,
// then swaps the visible right pane to it. No respawnPane on the visible
// right pane.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { Writable } from 'node:stream'
import { createResumeRegistry } from '../../../../src/core/resume-registry.ts'
import { stepName as toStepName } from '../../../../src/core/types.ts'
import { createRightPaneController } from '../../../../src/hosts/two-pane/pane-map/index.ts'
import { createPaneQueue } from '../../../../src/hosts/two-pane/pane-queue.ts'
import {
  defineRunner,
  type Runner,
  type RunnerCommand,
  type RunnerContext,
} from '../../../../src/runners/index.ts'
import { FakeTmuxService, paneId, socketName } from '../../../../src/services/tmux/index.ts'
import { path as toPath } from '../../../../src/services/types.ts'
import {
  type RunId,
  type RunState,
  type StateStore,
  type StepEntry,
  runId as toRunId,
} from '../../../../src/state/index.ts'

const RUN_ID: RunId = toRunId('r-2026-05-06-300000-fl')
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
    ...(overrides.sessionId !== undefined ? { sessionId: overrides.sessionId } : {}),
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
    runDir: (rid) => toPath(`/runs/${rid}`),
  }
}

function bufferingStderr(): { stream: NodeJS.WritableStream; chunks: string[] } {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
      cb()
    },
  }) as unknown as NodeJS.WritableStream
  return { stream, chunks }
}

function failingRunner(): Runner {
  return defineRunner({
    name: 'failing-resume',
    supports: { interactive: true, structuredOutput: false },
    buildCommand(ctx: RunnerContext): RunnerCommand {
      return { argv: ['failing'], env: ctx.env }
    },
    parseEvents() {
      return null
    },
    extractStructuredOutput() {
      return undefined
    },
    toTranscriptLines() {
      return []
    },
    resumeCommand(): RunnerCommand {
      throw new Error('synthetic resume failure')
    },
  })
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0))
}

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp('/tmp/orch-resume-failure-')
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('resume launcher — failure path (U8 swap-based, mocked tmux)', () => {
  it('writes the canonical "resume failed" footer and tails it from a hidden pane', async () => {
    const tmux = new FakeTmuxService()
    tmux.nextCreateSessionPaneId(paneId('%500'))
    const { stream, chunks } = bufferingStderr()
    const stateDir = `${tempDir}/state`
    await mkdir(stateDir, { recursive: true })

    const resumeRegistry = createResumeRegistry()
    resumeRegistry.register(toStepName('x'), failingRunner())

    const controller = createRightPaneController({
      tmux,
      socket: socketName('orch-resume-fail'),
      leftPaneId: paneId('%0'),
      rightPaneId: RIGHT_PANE,
      paneQueue: createPaneQueue(),
      stateStore: makeStore({
        x: makeStep({ name: 'x', mode: 'interactive', sessionId: 'sess-fail' }),
      }),
      runId: RUN_ID,
      stateDir: toPath(stateDir),
      cwd: toPath(tempDir),
      env: {},
      stderr: stream,
      resumeRegistry,
      width: 200,
      height: 50,
    })

    controller.onIntent({ type: 'enter', stepName: 'x' })
    await flush()

    // Footer lands in the replay file (the controller tails that file).
    const replayBytes = await Bun.file(`${stateDir}/.replay/x.txt`).text()
    expect(replayBytes).toContain('resume failed')
    expect(replayBytes).toContain('press f to return')

    // The controller registers a `file-tail` source in a per-source session
    // over that file. No respawnPane on the visible right pane.
    const creates = tmux.recordedCalls.filter((c) => c.method === 'createSession')
    expect(creates).toHaveLength(1)
    const create = creates[0]
    if (create?.method !== 'createSession') throw new Error('expected createSession')
    const command = create.opts.command
    if (command === undefined) throw new Error('expected command on createSession')
    expect(command[0]).toBe('tail')
    expect(command[4]).toMatch(/\.replay\/x\.txt$/)

    const respawns = tmux.recordedCalls.filter(
      (c) => c.method === 'respawnPane' && c.opts.target === RIGHT_PANE,
    )
    expect(respawns).toHaveLength(0)

    // No new window.
    expect(tmux.recordedCalls.some((c) => c.method === 'newWindow')).toBe(false)

    // No stderr write: see right-pane-controller-failure-recovery.test.ts.
    // The parent process shares the TTY with `tmux attach-session`, so any
    // fd-2 write bleeds across both panes. The error detail now lives in the
    // lifecycle log (`resume-failed` event with `errorMessage`); the warm-
    // cache file footer covers the user-visible surface.
    expect(chunks.join('')).toBe('')

    await controller.stop()
  })
})
