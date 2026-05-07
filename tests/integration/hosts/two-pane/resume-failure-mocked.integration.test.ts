// Integration coverage for the resume launcher's failure path. The runner's
// `resumeCommand` throws, and the controller must (a) write the canonical
// `"resume failed — press f to return..."` footer to the per-step replay
// file, (b) respawn the right pane with `cat <file>` so the user can see the
// message, and (c) NOT spawn a new window.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { Writable } from 'node:stream'
import { createPaneQueue } from '../../../../src/hosts/two-pane/pane-queue.ts'
import { createRightPaneController } from '../../../../src/hosts/two-pane/right-pane-controller.ts'
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

describe('resume launcher — failure path (mocked tmux)', () => {
  it('writes the canonical "resume failed" footer when resumeCommand throws', async () => {
    const tmux = new FakeTmuxService()
    const { stream, chunks } = bufferingStderr()
    const stateDir = `${tempDir}/state`
    await mkdir(stateDir, { recursive: true })

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
      resumeRunner: failingRunner(),
    })

    controller.onIntent({ type: 'enter', stepName: 'x' })
    await flush()

    // Footer lands in the replay file (the controller cats that file).
    const replayBytes = await Bun.file(`${stateDir}/.replay/x.txt`).text()
    expect(replayBytes).toContain('resume failed')
    expect(replayBytes).toContain('press f to return')

    // The controller respawns the right pane with cat <file> so the user
    // can read the failure footer in place. No new window is created.
    const respawns = tmux.recordedCalls.filter((c) => c.method === 'respawnPane')
    expect(respawns).toHaveLength(1)
    const first = respawns[0]
    if (first?.method !== 'respawnPane') throw new Error('expected respawn')
    expect(first.opts.target).toBe(RIGHT_PANE)
    expect(first.opts.argv[0]).toBe('cat')
    expect(tmux.recordedCalls.some((c) => c.method === 'newWindow')).toBe(false)

    expect(chunks.join('')).toContain('synthetic resume failure')

    await controller.stop()
  })
})
