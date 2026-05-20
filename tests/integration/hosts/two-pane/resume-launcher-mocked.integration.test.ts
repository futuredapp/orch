// Integration coverage for the U8 swap-based resume path. The interactive
// resume runner returns a `RunnerCommand`; the controller registers a `pty`
// source on the scratch session with that argv/env and swaps it in. No
// `respawnPane` on the visible right pane.

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

const RUN_ID: RunId = toRunId('r-2026-05-06-300000-rs')
const RIGHT_PANE = paneId('%1')
const SCRATCH_SOCKET = socketName('orch-scratch-resume')
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

function bufferStream(): NodeJS.WritableStream {
  return new Writable({
    write(_c, _e, cb) {
      cb()
    },
  }) as unknown as NodeJS.WritableStream
}

function makeResumableRunner(): Runner {
  return defineRunner({
    name: 'mocked-resume',
    supports: { interactive: true, structuredOutput: false },
    buildCommand(ctx: RunnerContext): RunnerCommand {
      return { argv: ['mocked-resume'], env: ctx.env }
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
    resumeCommand(ctx: RunnerContext, sessionId: string): RunnerCommand {
      return {
        argv: ['mocked-resume', '--resume', sessionId],
        env: { ...ctx.env, FORCE_COLOR: '3' },
      }
    },
  })
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0))
}

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp('/tmp/orch-rpc-resume-int-')
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('resume launcher (U8 swap-based, mocked tmux + scripted runner)', () => {
  it('spawns the resume argv as a pty source on the scratch session and swaps it in', async () => {
    const tmux = new FakeTmuxService()
    tmux.nextPaneId(paneId('%500'))
    const stateDir = `${tempDir}/state`
    await mkdir(stateDir, { recursive: true })

    const resumeRegistry = createResumeRegistry()
    resumeRegistry.register(toStepName('work-auth'), makeResumableRunner())

    const controller = createRightPaneController({
      tmux,
      socket: socketName('orch-resume-int'),
      leftPaneId: paneId('%0'),
      rightPaneId: RIGHT_PANE,
      paneQueue: createPaneQueue(),
      stateStore: makeStore({
        'work-auth': makeStep({
          name: 'work-auth',
          mode: 'interactive',
          sessionId: 'sess-int-001',
        }),
      }),
      runId: RUN_ID,
      stateDir: toPath(stateDir),
      cwd: toPath(tempDir),
      env: { HOME: '/home/orch' },
      stderr: bufferStream(),
      resumeRegistry,
      scratchSession: SCRATCH_SESSION,
    })

    controller.onIntent({ type: 'enter', stepName: 'work-auth' })
    await flush()

    const splits = tmux.recordedCalls.filter((c) => c.method === 'splitPane')
    expect(splits).toHaveLength(1)
    const split = splits[0]
    if (split?.method !== 'splitPane') throw new Error('expected splitPane')
    expect(split.opts.session).toBe('orch-scratch')
    expect(split.opts.argv).toEqual(['mocked-resume', '--resume', 'sess-int-001'])
    expect(split.opts.env?.FORCE_COLOR).toBe('3')
    expect(split.opts.env?.HOME).toBe('/home/orch')

    const swaps = tmux.recordedCalls.filter((c) => c.method === 'swapPane')
    expect(swaps).toHaveLength(1)
    const swap = swaps[0]
    if (swap?.method !== 'swapPane') throw new Error('expected swapPane')
    expect(swap.opts.src).toBe(paneId('%500'))
    expect(swap.opts.dst).toBe(RIGHT_PANE)

    // No respawnPane on the visible right pane.
    const respawns = tmux.recordedCalls.filter(
      (c) => c.method === 'respawnPane' && c.opts.target === RIGHT_PANE,
    )
    expect(respawns).toHaveLength(0)

    // No window-1 lifecycle.
    const methods = tmux.recordedCalls.map((c) => c.method)
    expect(methods).not.toContain('newWindow')
    expect(methods).not.toContain('selectWindow')
    expect(methods).not.toContain('killWindow')

    await controller.stop()
  })
})
