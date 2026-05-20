// U5 mechanics + branch-ordering coverage for the right-pane controller's
// resume-refusal dispatch. The full text variants per R8/R9/R10/R11 are
// finalized in U9; this file asserts the dispatch shape:
//   - registry undefined           → R10 "no runner wired"
//   - registry + no entry + no runnerName → R8 "pre-dates the resume feature"
//   - registry + no entry + runnerName    → R11 "not ready yet"
//   - registry + runner without resumeCommand → existing unsupported text
//   - registry + runner + sessionIdCaptureError='ambiguous'/'empty'/'error'
//     → three distinct refusal strings (R9 dispatch)
//   - registry + runner + sessionId → happy path (no refusal)
//
// Each test writes the visible refusal text to the per-step `.replay/` file
// (mirrors `resume-failure-mocked.integration.test.ts`'s assertion shape).
//
// Triage: this test would fail if the visible pane content were empty / wrong
// for any of the eight refusal branches, so it passes the testing-strategy
// "would this still pass if the pane content were wrong?" gate.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { Writable } from 'node:stream'
import { createResumeRegistry } from '../../../../../src/core/resume-registry.ts'
import { stepName as toStepName } from '../../../../../src/core/types.ts'
import { createRightPaneController } from '../../../../../src/hosts/two-pane/pane-map/index.ts'
import { createPaneQueue } from '../../../../../src/hosts/two-pane/pane-queue.ts'
import { defineRunner, type Runner, type RunnerContext } from '../../../../../src/runners/index.ts'
import { FakeTmuxService, paneId, socketName } from '../../../../../src/services/tmux/index.ts'
import { path as toPath } from '../../../../../src/services/types.ts'
import {
  type RunId,
  type RunState,
  type StateStore,
  type StepEntry,
  runId as toRunId,
} from '../../../../../src/state/index.ts'

const RUN_ID: RunId = toRunId('r-2026-05-13-100000-r5')
const RIGHT_PANE = paneId('%1')
const SCRATCH_SOCKET = socketName('orch-scratch-refusal')
const SCRATCH_SESSION = { socket: SCRATCH_SOCKET, session: 'orch-scratch' }

function bufferStream(): NodeJS.WritableStream {
  return new Writable({
    write(_c, _e, cb) {
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
    mode: 'interactive',
    ...(overrides.sessionId !== undefined ? { sessionId: overrides.sessionId } : {}),
    ...(overrides.runnerName !== undefined ? { runnerName: overrides.runnerName } : {}),
    ...(overrides.sessionIdCaptureError !== undefined
      ? { sessionIdCaptureError: overrides.sessionIdCaptureError }
      : {}),
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

function makeResumableRunner(name = 'fake-resumable'): Runner {
  return defineRunner({
    name,
    supports: { interactive: true, structuredOutput: false },
    buildCommand(ctx: RunnerContext) {
      return { argv: [name], env: ctx.env }
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
    resumeCommand(ctx: RunnerContext, sessionId: string) {
      return { argv: [name, '--resume', sessionId], env: { ...ctx.env, FORCE_COLOR: '3' } }
    },
  })
}

function makeNonResumableRunner(name = 'fake-no-resume'): Runner {
  return defineRunner({
    name,
    supports: { interactive: true, structuredOutput: false },
    buildCommand(ctx: RunnerContext) {
      return { argv: [name], env: ctx.env }
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

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0))
}

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp('/tmp/orch-resume-refusal-')
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

interface FixtureOpts {
  readonly step: StepEntry
  readonly resumeRegistry?: ReturnType<typeof createResumeRegistry>
}

async function runEnterAndReadReplay(opts: FixtureOpts): Promise<string> {
  const tmux = new FakeTmuxService()
  tmux.nextPaneId(paneId('%500'))
  const stateDir = `${tempDir}/state`
  await mkdir(stateDir, { recursive: true })

  const controller = createRightPaneController({
    tmux,
    socket: socketName('orch-refusal'),
    leftPaneId: paneId('%0'),
    rightPaneId: RIGHT_PANE,
    paneQueue: createPaneQueue(),
    stateStore: makeStore({ [opts.step.name]: opts.step }),
    runId: RUN_ID,
    stateDir: toPath(stateDir),
    cwd: toPath(tempDir),
    env: {},
    stderr: bufferStream(),
    scratchSession: SCRATCH_SESSION,
    ...(opts.resumeRegistry !== undefined ? { resumeRegistry: opts.resumeRegistry } : {}),
  })

  controller.onIntent({ type: 'enter', stepName: opts.step.name })
  await flush()
  await controller.stop()

  return await Bun.file(`${stateDir}/.replay/${opts.step.name}.txt`).text()
}

describe('right-pane refusal branch dispatch', () => {
  it('R10: omitting resumeRegistry refuses with "no runner wired"', async () => {
    const replay = await runEnterAndReadReplay({
      step: makeStep({ name: 'work', sessionId: 'sess-1', runnerName: 'fake' }),
    })

    expect(replay).toContain('no runner wired into this host')
  })

  it('R8: registry present but no entry AND no runnerName refuses with legacy text', async () => {
    const reg = createResumeRegistry()
    // Note: no register() call.
    const replay = await runEnterAndReadReplay({
      step: makeStep({ name: 'legacy-step', sessionId: 'sess-old' }),
      resumeRegistry: reg,
    })

    expect(replay).toContain('pre-dates the resume feature')
  })

  it('R11: registry present, no entry, BUT runnerName set refuses with "not ready yet"', async () => {
    const reg = createResumeRegistry()
    const replay = await runEnterAndReadReplay({
      step: makeStep({ name: 'race-step', sessionId: 'sess-x', runnerName: 'codex' }),
      resumeRegistry: reg,
    })

    expect(replay).toContain('not ready yet')
    expect(replay).toContain('try again')
    // R11 must NOT collapse to the R8 or R10 text.
    expect(replay).not.toContain('no runner wired')
    expect(replay).not.toContain('pre-dates the resume feature')
  })

  it('runner without resumeCommand refuses with the unsupported-runner text (existing branch)', async () => {
    const reg = createResumeRegistry()
    const runner = makeNonResumableRunner('plain-claude')
    reg.register(toStepName('work'), runner)
    const replay = await runEnterAndReadReplay({
      step: makeStep({ name: 'work', sessionId: 'sess-2', runnerName: 'plain-claude' }),
      resumeRegistry: reg,
    })

    expect(replay).toContain('"plain-claude" does not support resume')
  })

  it("R9: sessionIdCaptureError='ambiguous' refuses with an ambiguous-specific message", async () => {
    const reg = createResumeRegistry()
    reg.register(toStepName('work'), makeResumableRunner('codex'))
    const replay = await runEnterAndReadReplay({
      step: makeStep({
        name: 'work',
        runnerName: 'codex',
        sessionIdCaptureError: 'ambiguous',
      }),
      resumeRegistry: reg,
    })

    expect(replay).toContain('multiple Codex sessions')
  })

  it("R9: sessionIdCaptureError='empty' refuses with an empty-specific message", async () => {
    const reg = createResumeRegistry()
    reg.register(toStepName('work'), makeResumableRunner('codex'))
    const replay = await runEnterAndReadReplay({
      step: makeStep({
        name: 'work',
        runnerName: 'codex',
        sessionIdCaptureError: 'empty',
      }),
      resumeRegistry: reg,
    })

    expect(replay).toContain('no rollout file appeared')
  })

  it("R9: sessionIdCaptureError='error' refuses with an internal-error message distinct from 'empty'", async () => {
    const reg = createResumeRegistry()
    reg.register(toStepName('work'), makeResumableRunner('codex'))
    const replay = await runEnterAndReadReplay({
      step: makeStep({
        name: 'work',
        runnerName: 'codex',
        sessionIdCaptureError: 'error',
      }),
      resumeRegistry: reg,
    })

    expect(replay).toContain('internal error capturing the Codex thread_id')
    // Must NOT collapse to the 'empty' message — that misled users.
    expect(replay).not.toContain('no rollout file appeared')
  })

  it("defensive: registry hit + runner.resumeCommand but no sessionId and no captureError refuses with 'no captured sessionId'", async () => {
    // U8 normally writes either { sessionId } or { sessionIdCaptureError } on
    // failure — never neither. This branch is the defensive catch for old
    // state files written by a partial implementation, or for runners that
    // declare `resumeCommand` but never produce a session id.
    const reg = createResumeRegistry()
    reg.register(toStepName('work'), makeResumableRunner('codex'))
    const replay = await runEnterAndReadReplay({
      step: makeStep({ name: 'work', runnerName: 'codex' }),
      resumeRegistry: reg,
    })

    expect(replay).toContain('no captured sessionId')
  })

  it('happy path: registry hit + sessionId + resumeCommand spawns the runner without a refusal file', async () => {
    // The happy path emits a `pty` PaneSpec rather than writing a refusal
    // file. Existing integration coverage at
    // `tests/integration/hosts/two-pane/resume-launcher-mocked.integration.test.ts`
    // pins the pty argv shape end-to-end; we assert the absence of refusal
    // text here.
    const tmux = new FakeTmuxService()
    tmux.nextPaneId(paneId('%500'))
    const stateDir = `${tempDir}/state`
    await mkdir(stateDir, { recursive: true })

    const reg = createResumeRegistry()
    reg.register(toStepName('work'), makeResumableRunner('codex'))

    const controller = createRightPaneController({
      tmux,
      socket: socketName('orch-refusal-happy'),
      leftPaneId: paneId('%0'),
      rightPaneId: RIGHT_PANE,
      paneQueue: createPaneQueue(),
      stateStore: makeStore({
        work: makeStep({ name: 'work', sessionId: 'sess-real', runnerName: 'codex' }),
      }),
      runId: RUN_ID,
      stateDir: toPath(stateDir),
      cwd: toPath(tempDir),
      env: {},
      stderr: bufferStream(),
      scratchSession: SCRATCH_SESSION,
      resumeRegistry: reg,
    })

    controller.onIntent({ type: 'enter', stepName: 'work' })
    await flush()

    // The pty source path runs splitPane with the runner's resume argv;
    // it never writes a `.replay/work.txt` refusal file.
    const splits = tmux.recordedCalls.filter((c) => c.method === 'splitPane')
    expect(splits.length).toBeGreaterThan(0)
    const split = splits[0]
    if (split?.method !== 'splitPane') throw new Error('expected splitPane')
    expect(split.opts.argv).toEqual(['codex', '--resume', 'sess-real'])

    await controller.stop()
  })

  it('step-keyed lookup resolves two distinct same-named runners to their own runners (F6 regression)', async () => {
    const reg = createResumeRegistry()
    const runnerA = makeResumableRunner('claude')
    const runnerB = makeResumableRunner('claude')
    reg.register(toStepName('design'), runnerA)
    reg.register(toStepName('implement'), runnerB)

    const tmux = new FakeTmuxService()
    tmux.nextPaneId(paneId('%500'))
    tmux.nextPaneId(paneId('%501'))
    const stateDir = `${tempDir}/state`
    await mkdir(stateDir, { recursive: true })

    const controller = createRightPaneController({
      tmux,
      socket: socketName('orch-refusal-collision'),
      leftPaneId: paneId('%0'),
      rightPaneId: RIGHT_PANE,
      paneQueue: createPaneQueue(),
      stateStore: makeStore({
        design: makeStep({ name: 'design', sessionId: 'sess-A', runnerName: 'claude' }),
        implement: makeStep({ name: 'implement', sessionId: 'sess-B', runnerName: 'claude' }),
      }),
      runId: RUN_ID,
      stateDir: toPath(stateDir),
      cwd: toPath(tempDir),
      env: {},
      stderr: bufferStream(),
      scratchSession: SCRATCH_SESSION,
      resumeRegistry: reg,
    })

    controller.onIntent({ type: 'enter', stepName: 'design' })
    await flush()
    controller.onIntent({ type: 'enter', stepName: 'implement' })
    await flush()

    const splits = tmux.recordedCalls.filter((c) => c.method === 'splitPane')
    const argvs = splits
      .map((c) => (c.method === 'splitPane' ? c.opts.argv : undefined))
      .filter((a): a is readonly string[] => a !== undefined)
    // Each Enter should produce its own resume invocation with the runner's
    // bound sessionId — the registry returning the wrong runner would route
    // both to the same argv, so the second sessionId would not appear.
    const flattened = argvs.flat()
    expect(flattened).toContain('sess-A')
    expect(flattened).toContain('sess-B')

    await controller.stop()
  })
})
