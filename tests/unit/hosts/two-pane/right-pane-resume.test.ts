// Unit coverage for the Phase 3 resume launcher seam in
// `right-pane-controller`. The host port is exercised at the FakeTmuxService
// boundary; runners are wired via the lightweight `defineRunner` factory so
// each test injects exactly the shape it needs (resumeCommand-or-not).

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
  type PersistedWorkflowArgs,
  type RunId,
  type RunState,
  type StateStore,
  type StepEntry,
  runId as toRunId,
} from '../../../../src/state/index.ts'

const RUN_ID: RunId = toRunId('r-2026-05-05-200000-rs')
const RIGHT_PANE = paneId('%1')

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

function makeBaseRunner(): Runner {
  return defineRunner({
    name: 'unit-runner',
    supports: { interactive: true, structuredOutput: false },
    buildCommand(ctx: RunnerContext): RunnerCommand {
      return { argv: ['unit-runner'], env: ctx.env }
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
  })
}

function makeResumableRunner(): Runner {
  return defineRunner({
    ...makeBaseRunner(),
    resumeCommand(ctx: RunnerContext, sessionId: string): RunnerCommand {
      return { argv: ['unit-runner', '--resume', sessionId], env: ctx.env }
    },
  })
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0))
}

interface Harness {
  readonly tmux: FakeTmuxService
  readonly stateDir: string
  readonly stop: () => Promise<void>
  readonly onIntent: ReturnType<typeof createRightPaneController>['onIntent']
}

async function makeController(opts: {
  readonly tempDir: string
  readonly steps: Record<string, StepEntry>
  readonly resumeRunner?: Runner
}): Promise<Harness> {
  const tmux = new FakeTmuxService()
  const queue = createPaneQueue()
  const stateDir = `${opts.tempDir}/state`
  await mkdir(stateDir, { recursive: true })
  const controller = createRightPaneController({
    tmux,
    socket: socketName('orch-rp-resume'),
    leftPaneId: paneId('%0'),
    rightPaneId: RIGHT_PANE,
    paneQueue: queue,
    stateStore: makeStore(opts.steps),
    runId: RUN_ID,
    stateDir: toPath(stateDir),
    cwd: toPath(opts.tempDir),
    env: {},
    stderr: bufferStream(),
    ...(opts.resumeRunner !== undefined ? { resumeRunner: opts.resumeRunner } : {}),
  })
  return { tmux, stateDir, stop: () => controller.stop(), onIntent: controller.onIntent }
}

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp('/tmp/orch-rp-resume-')
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('right-pane-controller resume launcher (Phase 3)', () => {
  it("respawns the right pane with the runner's resume argv when sessionId + runner are present", async () => {
    const harness = await makeController({
      tempDir,
      resumeRunner: makeResumableRunner(),
      steps: {
        'work-auth': makeStep({
          name: 'work-auth',
          mode: 'interactive',
          sessionId: 'sess-1234',
        }),
      },
    })

    harness.onIntent({ type: 'enter', stepName: 'work-auth' })
    await flush()

    const respawn = harness.tmux.recordedCalls.find((c) => c.method === 'respawnPane')
    expect(respawn).toBeDefined()
    if (respawn?.method !== 'respawnPane') throw new Error('expected respawnPane')
    expect(respawn.opts.target).toBe(RIGHT_PANE)
    expect(respawn.opts.argv).toEqual(['unit-runner', '--resume', 'sess-1234'])
    expect(respawn.opts.killRunning).toBe(true)
    expect(harness.tmux.recordedCalls.some((c) => c.method === 'newWindow')).toBe(false)

    await harness.stop()
  })

  it('refuses with a footer message when no resumeRunner is wired', async () => {
    const harness = await makeController({
      tempDir,
      steps: {
        'work-x': makeStep({
          name: 'work-x',
          mode: 'interactive',
          sessionId: 'sess-1',
        }),
      },
    })

    harness.onIntent({ type: 'enter', stepName: 'work-x' })
    await flush()

    // Refusal goes through respawn cat <file> path, not sendKeys.
    const replayBytes = await Bun.file(`${harness.stateDir}/.replay/work-x.txt`).text()
    expect(replayBytes).toContain('resume unavailable')
    expect(replayBytes).toContain('no runner wired')

    // The runner's resume argv must NOT have been respawned — only the
    // refusal-cat. Argv should be ['cat', <path>].
    const respawns = harness.tmux.recordedCalls.filter((c) => c.method === 'respawnPane')
    expect(respawns).toHaveLength(1)
    const first = respawns[0]
    if (first?.method !== 'respawnPane') throw new Error('expected respawn')
    expect(first.opts.argv[0]).toBe('cat')

    await harness.stop()
  })

  it('refuses when the wired runner has no resumeCommand method', async () => {
    const harness = await makeController({
      tempDir,
      resumeRunner: makeBaseRunner(),
      steps: {
        plan: makeStep({ name: 'plan', mode: 'interactive', sessionId: 'sess-2' }),
      },
    })

    harness.onIntent({ type: 'enter', stepName: 'plan' })
    await flush()

    const replayBytes = await Bun.file(`${harness.stateDir}/.replay/plan.txt`).text()
    expect(replayBytes).toContain('does not support resume')

    const respawns = harness.tmux.recordedCalls.filter((c) => c.method === 'respawnPane')
    expect(respawns).toHaveLength(1)
    const first = respawns[0]
    if (first?.method !== 'respawnPane') throw new Error('expected respawn')
    expect(first.opts.argv[0]).toBe('cat')

    await harness.stop()
  })

  it('refuses when the step entry lacks a captured sessionId', async () => {
    const harness = await makeController({
      tempDir,
      resumeRunner: makeResumableRunner(),
      steps: {
        legacy: makeStep({ name: 'legacy', mode: 'interactive' }),
      },
    })

    harness.onIntent({ type: 'enter', stepName: 'legacy' })
    await flush()

    const replayBytes = await Bun.file(`${harness.stateDir}/.replay/legacy.txt`).text()
    expect(replayBytes).toContain('resume unavailable')
    expect(replayBytes).toContain('no captured sessionId')

    await harness.stop()
  })

  it('writes the failure footer when resumeCommand throws', async () => {
    const exploding = defineRunner({
      ...makeBaseRunner(),
      resumeCommand(): RunnerCommand {
        throw new Error('boom')
      },
    })
    const harness = await makeController({
      tempDir,
      resumeRunner: exploding,
      steps: {
        x: makeStep({ name: 'x', mode: 'interactive', sessionId: 'sess-x' }),
      },
    })

    harness.onIntent({ type: 'enter', stepName: 'x' })
    await flush()

    const replayBytes = await Bun.file(`${harness.stateDir}/.replay/x.txt`).text()
    expect(replayBytes).toContain('resume failed')

    await harness.stop()
  })
})
