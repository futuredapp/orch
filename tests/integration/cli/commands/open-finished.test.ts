// Integration coverage for the read-only finished-run open path (plan U1/U2).
//
// Drives the REAL `openFinished` against a fake two-pane host whose
// `awaitForegroundShutdown` resolves immediately (the user pressing `q`), with
// a real `FileStateStore` over a temp dir holding a pre-finished `completed`
// state.json. Asserts the pure-open contract: exit 0, zero step execution, and
// byte-for-byte unchanged `state.json`/`logs/` with zero logger appends — the
// observable surfaces AT-4/AT-5/AT-14/AT-15/AT-16/AT-17 name.

import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import { writeFinishedRun } from '@orch/test/finished-run-fixture.ts'
import { openFinished } from '../../../../src/cli/commands/open-finished.ts'
import type { CliDeps } from '../../../../src/cli/deps.ts'
import { type CliOpts, EXIT, type HostFactory } from '../../../../src/cli/main.ts'
import { createResumeRegistry } from '../../../../src/core/index.ts'
import { step } from '../../../../src/core/step.ts'
import type { StepName } from '../../../../src/core/types.ts'
import { workflow } from '../../../../src/core/workflow.ts'
import type {
  ForegroundShutdownReason,
  Host,
  HostReachability,
  PaneAttachment,
  PaneRole,
} from '../../../../src/hosts/index.ts'
import {
  createNullSessionLogger,
  type JsonObject,
  type LogCategory,
  type SessionLogger,
} from '../../../../src/observability/index.ts'
import { FakeRunner } from '../../../../src/runners/index.ts'
import {
  BunFsService,
  FakeClock,
  FakeGitService,
  FakeProcessService,
  path,
} from '../../../../src/services/index.ts'
import { FakeConfirmService, FakePromptService } from '../../../../src/services/prompt/index.ts'
import { FileRunRegistry, FileStateStore, type RunId } from '../../../../src/state/index.ts'

let tmpDir: string

afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

const COMPLETED_ID = 'r-2026-04-13-438944-09' as RunId

const DEFAULT_OPTS: CliOpts = {
  mode: 'two-pane',
  format: 'text',
  noAttach: false,
  debug: false,
  interactivity: 'interactive',
  latest: false,
  step: undefined,
  follow: false,
  watch: false,
}

interface SpyLogger extends SessionLogger {
  readonly appends: ReadonlyArray<{ category: LogCategory; record: JsonObject }>
  readonly writes: readonly string[]
}

// Wraps the null logger and counts the two mutation-bearing methods. The pure
// open must never append a `run:resumed` lifecycle entry or write `run.meta.json`.
function makeSpyLogger(rid: RunId): SpyLogger {
  const base = createNullSessionLogger({ runId: rid })
  const appends: { category: LogCategory; record: JsonObject }[] = []
  const writes: string[] = []
  return {
    ...base,
    appends,
    writes,
    async append(category: LogCategory, record: JsonObject): Promise<void> {
      appends.push({ category, record })
      await base.append(category, record)
    },
    async writeFile(relPath: string, body: string): Promise<void> {
      writes.push(relPath)
      await base.writeFile(relPath, body)
    },
  }
}

interface SpyHost extends Host {
  readonly attachedForeground: () => boolean
  readonly tornDown: () => boolean
  readonly runnerTouched: () => boolean
}

// A two-pane host whose foreground settles immediately with `quit` (the user
// pressing `q`). Records whether any runner/step surface was touched so the
// "no steps execute" guarantee is observable.
function makeSpyTwoPaneHost(): SpyHost {
  let attached = false
  let teardownCalled = false
  let runnerTouched = false
  return {
    get mode() {
      return 'two-pane' as const
    },
    writeBanner(): void {},
    onRunnerEvent(): void {
      runnerTouched = true
    },
    onLifecycleEvent(): void {
      runnerTouched = true
    },
    onCommandLine(): void {},
    async attach(pane: PaneRole): Promise<PaneAttachment> {
      return { pane, async detach() {} }
    },
    async runInteractive() {
      runnerTouched = true
      return { exitCode: 0, durationMs: 0 }
    },
    async attachForeground(): Promise<void> {
      attached = true
    },
    async awaitForegroundShutdown(): Promise<ForegroundShutdownReason> {
      return 'quit'
    },
    async probeReachability(): Promise<HostReachability> {
      return { reachable: true }
    },
    async teardown(): Promise<void> {
      teardownCalled = true
    },
    attachedForeground: () => attached,
    tornDown: () => teardownCalled,
    runnerTouched: () => runnerTouched,
  }
}

async function makeDepsWithCompletedRun(logger: SessionLogger): Promise<CliDeps> {
  const bunFs = new BunFsService()
  const basePath = path(tmpDir)
  const stateStore = new FileStateStore({ fs: bunFs, basePath })
  await writeFinishedRun(stateStore, {
    runId: COMPLETED_ID,
    status: 'completed',
    workflowName: 'demo',
    startedAt: 1000,
    endedAt: 5000,
    steps: [{ name: 'plan', value: { result: 'ok' } }],
  })
  return {
    processService: new FakeProcessService(),
    fsService: bunFs,
    gitService: new FakeGitService(),
    clock: new FakeClock(9000),
    stateStore,
    registry: new FileRunRegistry({ fs: bunFs, basePath }),
    cwd: path(tmpDir),
    statePath: basePath,
    debug: false,
    sessionLoggerFor: () => logger,
    promptServiceFor: () => new FakePromptService(),
    confirmService: new FakeConfirmService(),
    isStdinTty: true,
  }
}

describe('openFinished — read-only finished-run open (integration)', () => {
  it('exits 0 when the user quits the read-only viewer (AT-4)', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-open-finished-')
    const logger = makeSpyLogger(COMPLETED_ID)
    const deps = await makeDepsWithCompletedRun(logger)
    const host = makeSpyTwoPaneHost()
    const hostFactory: HostFactory = async () => host

    const code = await openFinished({
      deps,
      targetId: COMPLETED_ID,
      workflowName: 'demo',
      status: 'completed',
      opts: DEFAULT_OPTS,
      hostFactory,
    })

    expect(code).toBe(EXIT.OK)
    expect(host.attachedForeground()).toBe(true)
    expect(host.tornDown()).toBe(true)
  })

  it('runs no workflow step on a read-only open (AT-5)', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-open-finished-')
    const logger = makeSpyLogger(COMPLETED_ID)
    const deps = await makeDepsWithCompletedRun(logger)
    const host = makeSpyTwoPaneHost()

    await openFinished({
      deps,
      targetId: COMPLETED_ID,
      workflowName: 'demo',
      status: 'completed',
      opts: DEFAULT_OPTS,
      hostFactory: async () => host,
    })

    expect(host.runnerTouched()).toBe(false)
  })

  it('leaves state.json byte-for-byte unchanged (AT-14)', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-open-finished-')
    const logger = makeSpyLogger(COMPLETED_ID)
    const deps = await makeDepsWithCompletedRun(logger)
    const statePath = `${tmpDir}/${COMPLETED_ID}/state.json`
    const before = await fs.readFile(statePath, 'utf-8')

    await openFinished({
      deps,
      targetId: COMPLETED_ID,
      workflowName: 'demo',
      status: 'completed',
      opts: DEFAULT_OPTS,
      hostFactory: async () => makeSpyTwoPaneHost(),
    })

    const after = await fs.readFile(statePath, 'utf-8')
    expect(after).toBe(before)
  })

  it('writes no run-lifecycle entry and no run-log file on a pure open (AT-15/AT-17)', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-open-finished-')
    const logger = makeSpyLogger(COMPLETED_ID)
    const deps = await makeDepsWithCompletedRun(logger)

    await openFinished({
      deps,
      targetId: COMPLETED_ID,
      workflowName: 'demo',
      status: 'completed',
      opts: DEFAULT_OPTS,
      hostFactory: async () => makeSpyTwoPaneHost(),
    })

    expect(logger.appends).toEqual([])
    expect(logger.writes).toEqual([])
  })

  it('spawns no cmux subprocess on a pure open (AT-16)', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-open-finished-')
    const logger = makeSpyLogger(COMPLETED_ID)
    const deps = await makeDepsWithCompletedRun(logger)
    const fps = deps.processService as FakeProcessService

    await openFinished({
      deps,
      targetId: COMPLETED_ID,
      workflowName: 'demo',
      status: 'completed',
      opts: DEFAULT_OPTS,
      hostFactory: async () => makeSpyTwoPaneHost(),
    })

    expect(fps.cmuxCalls()).toEqual([])
  })

  it('rehydrates the resume registry so a past interactive step resolves its runner (AT-18)', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-open-finished-')
    const logger = makeSpyLogger(COMPLETED_ID)
    const bunFs = new BunFsService()
    const basePath = path(tmpDir)
    const stateStore = new FileStateStore({ fs: bunFs, basePath })
    await writeFinishedRun(stateStore, {
      runId: COMPLETED_ID,
      status: 'completed',
      workflowName: 'demo',
      steps: [{ name: 'chat', mode: 'interactive', value: { exitCode: 0, durationMs: 0 } }],
    })
    const deps: CliDeps = {
      processService: new FakeProcessService(),
      fsService: bunFs,
      gitService: new FakeGitService(),
      clock: new FakeClock(9000),
      stateStore,
      registry: new FileRunRegistry({ fs: bunFs, basePath }),
      cwd: path(tmpDir),
      statePath: basePath,
      debug: false,
      sessionLoggerFor: () => logger,
      promptServiceFor: () => new FakePromptService(),
      confirmService: new FakeConfirmService(),
      isStdinTty: true,
    }

    // The workflow the cold open would load from `.orch/`, injected so the
    // fixture-seeded run rehydrates without a real workflow file on disk.
    const chatRunner = new FakeRunner(deps.processService as FakeProcessService).withResumeCommand()
    const CHAT = step.define('chat', { agent: chatRunner, mode: 'interactive' })
    const wf = workflow('demo', async (run) => {
      await run(CHAT)
    })

    const resumeRegistry = createResumeRegistry()
    const statePath = `${tmpDir}/${COMPLETED_ID}/state.json`
    const before = await fs.readFile(statePath, 'utf-8')

    await openFinished({
      deps,
      targetId: COMPLETED_ID,
      workflowName: 'demo',
      status: 'completed',
      opts: DEFAULT_OPTS,
      hostFactory: async () => makeSpyTwoPaneHost(),
      loaded: { executor: wf, config: { workflows: {} } },
      resumeRegistry,
    })

    // The right pane can now resolve the runner on `⏎` — no "resume not ready yet".
    expect(resumeRegistry.getRunnerForStep('chat' as StepName)).toBe(chatRunner)
    // Pure open preserved: the rehydration replay mutated nothing.
    expect(await fs.readFile(statePath, 'utf-8')).toBe(before)
    expect(logger.appends).toEqual([])
    expect(logger.writes).toEqual([])
  })
})
