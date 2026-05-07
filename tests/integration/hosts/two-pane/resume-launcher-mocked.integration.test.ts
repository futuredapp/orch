// Integration coverage for the Phase 3 resume launcher driving the real
// `createRightPaneController` against a `FakeTmuxService` recorder. The
// runner is wired via `defineRunner` so the integration shape (intent →
// dispatch → tmux argv) is exercised end-to-end without running real CLIs.

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

const RUN_ID: RunId = toRunId('r-2026-05-06-300000-rs')
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

describe('resume launcher (mocked tmux + scripted runner)', () => {
  it("respawns rightPaneId with the runner's resume argv on enter for an interactive agent step", async () => {
    const tmux = new FakeTmuxService()
    const stateDir = `${tempDir}/state`
    await mkdir(stateDir, { recursive: true })

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
      resumeRunner: makeResumableRunner(),
    })

    controller.onIntent({ type: 'enter', stepName: 'work-auth' })
    await flush()

    const respawn = tmux.recordedCalls.find((c) => c.method === 'respawnPane')
    expect(respawn).toBeDefined()
    if (respawn?.method !== 'respawnPane') throw new Error('expected respawnPane')
    expect(respawn.opts.target).toBe(RIGHT_PANE)
    expect(respawn.opts.argv).toEqual(['mocked-resume', '--resume', 'sess-int-001'])
    expect(respawn.opts.env?.FORCE_COLOR).toBe('3')
    expect(respawn.opts.env?.HOME).toBe('/home/orch')

    // No window-1 lifecycle.
    const methods = tmux.recordedCalls.map((c) => c.method)
    expect(methods).not.toContain('newWindow')
    expect(methods).not.toContain('selectWindow')
    expect(methods).not.toContain('killWindow')

    await controller.stop()
  })

  it('respawns the cat placeholder on follow-live after a resume enter', async () => {
    const tmux = new FakeTmuxService()
    const stateDir = `${tempDir}/state`
    await mkdir(stateDir, { recursive: true })

    const controller = createRightPaneController({
      tmux,
      socket: socketName('orch-resume-followlive'),
      leftPaneId: paneId('%0'),
      rightPaneId: RIGHT_PANE,
      paneQueue: createPaneQueue(),
      stateStore: makeStore({
        plan: makeStep({ name: 'plan', mode: 'interactive', sessionId: 'sess-zz' }),
      }),
      runId: RUN_ID,
      stateDir: toPath(stateDir),
      cwd: toPath(tempDir),
      env: {},
      stderr: bufferStream(),
      resumeRunner: makeResumableRunner(),
    })

    controller.onIntent({ type: 'enter', stepName: 'plan' })
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
