// Integration coverage for the interactive `failed` open loop (plan U6).
//
// Drives the REAL `openFailed` (and `resumeCmd`'s failed branch) against a
// fake two-pane host whose `awaitForegroundShutdown` is scripted to emit the
// `[r]`/`[c]`/quit outcomes, with a real `FileStateStore` + `FakeRunner` over a
// temp dir. The `failed` state is produced by actually executing a workflow
// whose middle step fails (real cache state), so `[r]`/`[c]` re-run exactly the
// way they would in production.
//
// Covers (CLI-loop level): AT-2 routing (park, never silent re-run), AT-R1
// (`[r]` passes → step ok, run stays failed, parked), AT-R2 (`[r]` fails again
// → back to the view), AT-R3 (`[c]` runs to completion), AT-R4 (un-actioned
// quit mutates nothing), AT-20 failed half (no-TTY refuses, never re-runs).

import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import { createFakeHost } from '@orch/test/fake-host.ts'
import { openFailed } from '../../../../src/cli/commands/open-failed.ts'
import { resumeCmd } from '../../../../src/cli/commands/resume.ts'
import type { CliDeps } from '../../../../src/cli/deps.ts'
import { type CliOpts, EXIT, type HostFactory } from '../../../../src/cli/main.ts'
import { createResumeRegistry, noRetry } from '../../../../src/core/index.ts'
import { step } from '../../../../src/core/step.ts'
import type { StepName } from '../../../../src/core/types.ts'
import type { WorkflowDeps } from '../../../../src/core/workflow.ts'
import { workflow } from '../../../../src/core/workflow.ts'
import type {
  ForegroundShutdownReason,
  Host,
  HostReachability,
  PaneAttachment,
  PaneRole,
} from '../../../../src/hosts/index.ts'
import { projectStepsView } from '../../../../src/hosts/two-pane/steps-view/index.ts'
import { createNullSessionLogger } from '../../../../src/observability/index.ts'
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
let stderr: string
let restoreStderr: (() => void) | undefined

afterEach(async () => {
  restoreStderr?.()
  restoreStderr = undefined
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

function captureStderr(): void {
  stderr = ''
  const original = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: unknown): boolean => {
    stderr += String(chunk)
    return true
  }) as typeof process.stderr.write
  restoreStderr = () => {
    process.stderr.write = original
  }
}

const FAILED_ID = 'r-2026-06-09-700001-ff' as RunId

const TWO_PANE_OPTS: CliOpts = {
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

const PLAIN_OPTS: CliOpts = { ...TWO_PANE_OPTS, mode: 'plain' }

// A fake two-pane host whose foreground settles with a scripted reason. The
// loop builds a fresh host per viewer open, so the factory pulls the next
// reason off a shared queue — modelling the user pressing [r], then [c]/q.
function makeScriptedHost(
  reason: ForegroundShutdownReason,
): Host & { runnerTouched: () => boolean; attachedForeground: () => boolean } {
  let touched = false
  let attached = false
  const fake = createFakeHost({ mode: 'two-pane' })
  return {
    ...fake,
    onRunnerEvent(...a): void {
      touched = true
      fake.onRunnerEvent(...a)
    },
    async runInteractive(spawn): Promise<{ exitCode: number; durationMs: number }> {
      touched = true
      return fake.runInteractive(spawn)
    },
    async attach(pane: PaneRole): Promise<PaneAttachment> {
      return { pane, async detach() {} }
    },
    async attachForeground(): Promise<void> {
      attached = true
    },
    async awaitForegroundShutdown(): Promise<ForegroundShutdownReason> {
      return reason
    },
    async probeReachability(): Promise<HostReachability> {
      return { reachable: true }
    },
    async teardown(): Promise<void> {},
    runnerTouched: () => touched,
    attachedForeground: () => attached,
  }
}

// Builds a CliDeps + the matching execute() WorkflowDeps over one shared
// FileStateStore / FakeProcessService, so the run executed to `failed` and the
// later `openFailed` see the same state and the same FakeRunner queue.
async function setup(): Promise<{
  readonly deps: CliDeps
  readonly wf: ReturnType<typeof workflow>
  readonly step2: FakeRunner
}> {
  tmpDir = await fs.mkdtemp('/tmp/orch-open-failed-')
  const bunFs = new BunFsService()
  const basePath = path(tmpDir)
  const processService = new FakeProcessService()
  const stateStore = new FileStateStore({ fs: bunFs, basePath })
  const clock = new FakeClock(1000)

  const deps: CliDeps = {
    processService,
    fsService: bunFs,
    gitService: new FakeGitService(),
    clock,
    stateStore,
    registry: new FileRunRegistry({ fs: bunFs, basePath }),
    cwd: path(tmpDir),
    statePath: basePath,
    debug: false,
    sessionLoggerFor: (rid) => createNullSessionLogger({ runId: rid }),
    promptServiceFor: () => new FakePromptService(),
    confirmService: new FakeConfirmService(),
    isStdinTty: true,
  }

  // step1 succeeds (cache-replayed on retry), step2 is the failure under test,
  // step3 must not run until a [c] continue.
  const r1 = new FakeRunner(processService)
  r1.script({ structuredOutput: 'one-ok' })
  const step2 = new FakeRunner(processService)
  const r3 = new FakeRunner(processService)
  r3.script({ structuredOutput: 'three-ok' })

  const S1 = step.define('step1', { agent: r1 })
  const S2 = step.define('step2', { agent: step2, recovery: noRetry() })
  const S3 = step.define('step3', { agent: r3 })
  const wf = workflow('three-step', async (run) => {
    await run(S1)
    await run(S2)
    await run(S3)
  })

  // Drive the run to `failed`: step2's first scripted entry fails.
  step2.script({ failWith: { message: 'boom', exitCode: 7 } })
  const execDeps: WorkflowDeps = {
    stateStore,
    processService,
    clock,
    runId: FAILED_ID,
    cwd: path(tmpDir),
    fsService: bunFs,
    gitService: new FakeGitService(),
    workflowName: 'three-step',
    host: createFakeHost(),
    promptService: new FakePromptService(),
    interactivity: 'interactive',
  }
  await wf.execute(execDeps).catch(() => {})

  return { deps, wf, step2 }
}

async function loadState(deps: CliDeps) {
  const s = await deps.stateStore.loadRun(FAILED_ID)
  if (s === undefined) throw new Error('failed run not seeded')
  return s
}

describe('openFailed — interactive failed open loop (integration)', () => {
  it('quitting an un-actioned failed view mutates nothing and exits 0 (AT-R4)', async () => {
    const { deps, wf } = await setup()
    const state = await loadState(deps)
    const statePath = `${tmpDir}/${FAILED_ID}/state.json`
    const before = await fs.readFile(statePath, 'utf-8')
    const host = makeScriptedHost('quit')
    const hostFactory: HostFactory = async () => host

    const code = await openFailed({
      deps,
      targetId: FAILED_ID,
      state,
      workflowName: 'three-step',
      cliArgs: {},
      opts: TWO_PANE_OPTS,
      hostFactory,
      loaded: { executor: wf, config: { workflows: {} } },
    })

    expect(code).toBe(EXIT.OK)
    expect(host.runnerTouched()).toBe(false)
    expect(await fs.readFile(statePath, 'utf-8')).toBe(before)
  })

  it('rehydrates the resume registry so a past interactive step resolves its runner (AT-18)', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-open-failed-')
    const bunFs = new BunFsService()
    const basePath = path(tmpDir)
    const processService = new FakeProcessService()
    const stateStore = new FileStateStore({ fs: bunFs, basePath })
    const clock = new FakeClock(1000)
    const deps: CliDeps = {
      processService,
      fsService: bunFs,
      gitService: new FakeGitService(),
      clock,
      stateStore,
      registry: new FileRunRegistry({ fs: bunFs, basePath }),
      cwd: path(tmpDir),
      statePath: basePath,
      debug: false,
      sessionLoggerFor: (rid) => createNullSessionLogger({ runId: rid }),
      promptServiceFor: () => new FakePromptService(),
      confirmService: new FakeConfirmService(),
      isStdinTty: true,
    }

    // chat (interactive) succeeds and is cached; build (autonomous) then fails,
    // driving the run to `failed`.
    const chatRunner = new FakeRunner(processService).withResumeCommand()
    chatRunner.script({ sessionId: 'sess-chat', structuredOutput: null })
    const buildRunner = new FakeRunner(processService)
    buildRunner.script({ failWith: { message: 'boom', exitCode: 7 } })
    const CHAT = step.define('chat', { agent: chatRunner, mode: 'interactive' })
    const BUILD = step.define('build', { agent: buildRunner, recovery: noRetry() })
    const wf = workflow('chat-then-build', async (run) => {
      await run(CHAT)
      await run(BUILD)
    })
    const execDeps: WorkflowDeps = {
      stateStore,
      processService,
      clock,
      runId: FAILED_ID,
      cwd: path(tmpDir),
      fsService: bunFs,
      gitService: new FakeGitService(),
      workflowName: 'chat-then-build',
      host: createFakeHost({ mode: 'two-pane' }),
      promptService: new FakePromptService(),
      interactivity: 'interactive',
    }
    await wf.execute(execDeps).catch(() => {})

    const state = await loadState(deps)
    const statePath = `${tmpDir}/${FAILED_ID}/state.json`
    const before = await fs.readFile(statePath, 'utf-8')
    const resumeRegistry = createResumeRegistry()

    const code = await openFailed({
      deps,
      targetId: FAILED_ID,
      state,
      workflowName: 'chat-then-build',
      cliArgs: {},
      opts: TWO_PANE_OPTS,
      hostFactory: async () => makeScriptedHost('quit'),
      loaded: { executor: wf, config: { workflows: {} } },
      resumeRegistry,
    })

    expect(code).toBe(EXIT.OK)
    // The park view rehydrated the registry — `⏎` resolves the runner.
    expect(resumeRegistry.getRunnerForStep('chat' as StepName)).toBe(chatRunner)
    // Pure park-view open preserved: the rehydration mutated nothing.
    expect(await fs.readFile(statePath, 'utf-8')).toBe(before)
  })

  it('[r] re-runs only the failed step, keeps the run failed, then reopens and quits (AT-R1)', async () => {
    const { deps, wf, step2 } = await setup()
    step2.script({ structuredOutput: 'two-ok' }) // the retry now passes
    const state = await loadState(deps)

    // Three host pulls now that `[r]` runs ATTACHED (Group 3): first viewer →
    // `[r]`; the retry execution → benign `attach-exited` (workflow settles, the
    // user watches it); the reopened viewer → quit.
    const reasons: ForegroundShutdownReason[] = [
      { type: 'action', action: 'retry' },
      'attach-exited',
    ]
    let i = 0
    const hostFactory: HostFactory = async () => makeScriptedHost(reasons[i++] ?? 'quit')

    const code = await openFailed({
      deps,
      targetId: FAILED_ID,
      state,
      workflowName: 'three-step',
      cliArgs: {},
      opts: TWO_PANE_OPTS,
      hostFactory,
      loaded: { executor: wf, config: { workflows: {} } },
    })

    expect(code).toBe(EXIT.OK)
    const parked = await deps.stateStore.loadRun(FAILED_ID)
    expect(parked?.status).toBe('failed') // KTD-8: run stays failed
    expect(parked?.steps.step2?.value).toBe('two-ok') // step flipped to success
    expect(parked?.steps.step3).toBeUndefined() // no later step ran (parked)
  })

  it('[r] retry runs ATTACHED (visible), not detached (Group 3)', async () => {
    // Group 3 regression: `[r]` used to call `executor.retryStep()` directly and
    // tear the host down WITHOUT ever attaching the foreground, so the
    // single-step retry re-executed into a DETACHED session — a blank screen for
    // autonomous steps, and an interactive retried step running into panes no
    // human is attached to. It must now attach exactly as `[c]`/`orch retry` do.
    // Asserted on the retry-execution host: the loop builds three hosts in order
    // — first viewer, retry execution (index 1), reopened viewer — and only the
    // retry-execution host distinguishes the fix (the viewers always attach).
    const { deps, wf, step2 } = await setup()
    step2.script({ structuredOutput: 'two-ok' }) // the retry passes

    const reasons: ForegroundShutdownReason[] = [
      { type: 'action', action: 'retry' },
      'attach-exited',
    ]
    const hosts: ReturnType<typeof makeScriptedHost>[] = []
    let i = 0
    const hostFactory: HostFactory = async () => {
      const host = makeScriptedHost(reasons[i++] ?? 'quit')
      hosts.push(host)
      return host
    }

    const code = await openFailed({
      deps,
      targetId: FAILED_ID,
      state: await loadState(deps),
      workflowName: 'three-step',
      cliArgs: {},
      opts: TWO_PANE_OPTS,
      hostFactory,
      loaded: { executor: wf, config: { workflows: {} } },
    })

    expect(code).toBe(EXIT.OK)
    expect(hosts[1]?.attachedForeground()).toBe(true) // retry watched in place, not detached
    expect(hosts[1]?.runnerTouched()).toBe(true) // the failed step actually re-ran on it
    const parked = await deps.stateStore.loadRun(FAILED_ID)
    expect(parked?.steps.step2?.value).toBe('two-ok') // the retry still parked the run correctly
  })

  it('[r] that fails again leaves the run failed and reopens the view (AT-R2)', async () => {
    const { deps, wf, step2 } = await setup()
    step2.script({ failWith: { message: 'boom-again', exitCode: 7 } }) // retry fails again
    const state = await loadState(deps)

    // viewer → `[r]`; the attached retry execution → `attach-exited` (a
    // failed-again retry still settles cleanly, no throw); reopened viewer → quit.
    const reasons: ForegroundShutdownReason[] = [
      { type: 'action', action: 'retry' },
      'attach-exited',
    ]
    let i = 0
    const hostFactory: HostFactory = async () => makeScriptedHost(reasons[i++] ?? 'quit')

    const code = await openFailed({
      deps,
      targetId: FAILED_ID,
      state,
      workflowName: 'three-step',
      cliArgs: {},
      opts: TWO_PANE_OPTS,
      hostFactory,
      loaded: { executor: wf, config: { workflows: {} } },
    })

    expect(code).toBe(EXIT.OK)
    const parked = await deps.stateStore.loadRun(FAILED_ID)
    expect(parked?.status).toBe('failed')
    expect(parked?.steps.step2).toBeUndefined() // never persisted a success
    expect(parked?.steps.step3).toBeUndefined()
  })

  it('[c] retry-and-continue drives the workflow to completion (AT-R3)', async () => {
    const { deps, wf, step2 } = await setup()
    step2.script({ structuredOutput: 'two-ok' }) // the continue re-run passes
    const state = await loadState(deps)

    // First viewer → [c]; the continue then runs on an executing host whose
    // foreground simply detaches once the workflow completes.
    const reasons: ForegroundShutdownReason[] = [
      { type: 'action', action: 'retry-continue' },
      'attach-exited',
    ]
    let i = 0
    const hostFactory: HostFactory = async () => makeScriptedHost(reasons[i++] ?? 'attach-exited')

    const code = await openFailed({
      deps,
      targetId: FAILED_ID,
      state,
      workflowName: 'three-step',
      cliArgs: {},
      opts: TWO_PANE_OPTS,
      hostFactory,
      loaded: { executor: wf, config: { workflows: {} } },
    })

    expect(code).toBe(EXIT.OK)
    const done = await deps.stateStore.loadRun(FAILED_ID)
    expect(done?.status).toBe('completed') // failed → completed
    expect(done?.steps.step2?.value).toBe('two-ok')
    expect(done?.steps.step3?.value).toBe('three-ok')
  })

  it('reopening a parked run after a passed [r], quit-before-continue, re-runs nothing (AT-R10a)', async () => {
    // The KTD-8 parked state AT-R1 *creates* but no other AT re-opens: `[r]`
    // passes, the user quits BEFORE `[c]`, and a LATER `orch resume <same-id>`
    // (a fresh process) must re-open the failed view with the step shown ok and
    // run NOTHING until the user acts again. This is the plan-added scenario in
    // the Test-strategy section ("retry-only success → quit → reopen").
    const { deps, wf, step2 } = await setup()
    step2.script({ structuredOutput: 'two-ok' }) // the retry passes

    // First process: [r] passes (watched on an attached host → `attach-exited`),
    // then the user quits the reopened viewer before continuing.
    const firstReasons: ForegroundShutdownReason[] = [
      { type: 'action', action: 'retry' },
      'attach-exited',
    ]
    let fi = 0
    const firstFactory: HostFactory = async () => makeScriptedHost(firstReasons[fi++] ?? 'quit')
    const firstCode = await openFailed({
      deps,
      targetId: FAILED_ID,
      state: await loadState(deps),
      workflowName: 'three-step',
      cliArgs: {},
      opts: TWO_PANE_OPTS,
      hostFactory: firstFactory,
      loaded: { executor: wf, config: { workflows: {} } },
    })
    expect(firstCode).toBe(EXIT.OK)

    const parked = await deps.stateStore.loadRun(FAILED_ID)
    expect(parked?.status).toBe('failed') // KTD-8: stays failed
    expect(parked?.steps.step2?.value).toBe('two-ok') // step flipped to ok
    const invocationsAfterRetry = step2.invocationCount

    // Second, independent process: a later `orch resume <same-id>` re-opens the
    // parked run. It loads cleanly from disk, re-opens the failed view, and
    // re-runs nothing — the runner boundary count is unchanged and the on-disk
    // state is still the coherent parked-failed state (step2 ok, step3 unrun).
    const reopenHost = makeScriptedHost('quit')
    const reopenCode = await openFailed({
      deps,
      targetId: FAILED_ID,
      state: await loadState(deps), // fresh load — models a new process
      workflowName: 'three-step',
      cliArgs: {},
      opts: TWO_PANE_OPTS,
      hostFactory: async () => reopenHost,
      loaded: { executor: wf, config: { workflows: {} } },
    })

    expect(reopenCode).toBe(EXIT.OK)
    expect(reopenHost.runnerTouched()).toBe(false) // nothing re-ran on the reopen
    expect(step2.invocationCount).toBe(invocationsAfterRetry) // runner boundary unchanged
    const reopened = await deps.stateStore.loadRun(FAILED_ID)
    expect(reopened?.status).toBe('failed') // still parked-failed → [c] still offered
    expect(reopened?.steps.step2?.value).toBe('two-ok')
    expect(reopened?.steps.step3).toBeUndefined()

    // Observe the PROJECTED view, not just on-disk state: feeding the parked
    // state.json through the projector must yield `failed` so `StepsView` keeps
    // gating the `[c]` continue affordance on. Asserting only on-disk status
    // leaves the projector's terminal-status split (the actual regression
    // surface) untested — the parked shape has zero failed step rows and would
    // otherwise mis-project as `completed`, hiding `[c]`.
    const projected = projectStepsView({
      run: reopened,
      overlay: new Map(),
      workflowName: 'three-step',
      runIdFallback: FAILED_ID,
    })
    expect(projected.status).toBe('failed')
  })

  it('after a [c] completion, a later `orch resume` re-routes the now-completed run to the read-only viewer (AT-R10)', async () => {
    // State coherence across a CLI retry: a `[c]` drives `failed → completed`,
    // then a subsequent `orch resume <same-id>` finds a `completed` run and
    // routes to the read-only viewer. The second open must load without a
    // corruption error and execute nothing (the run is terminal).
    //
    // H2: the reopen drives the REAL `resumeCmd` — which re-loads the now-
    // `completed` state from disk and *decides* the read-only branch — rather
    // than calling `openFinished` with a hand-passed `status`. Calling the leaf
    // directly bypassed exactly the routing AT-R10 protects: that a later
    // `orch resume` re-routes to `openFinished` (not `openFailed`/a re-run).
    const { deps, wf, step2 } = await setup()
    step2.script({ structuredOutput: 'two-ok' }) // the continue re-run passes

    const reasons: ForegroundShutdownReason[] = [
      { type: 'action', action: 'retry-continue' },
      'attach-exited',
    ]
    let i = 0
    const firstFactory: HostFactory = async () => makeScriptedHost(reasons[i++] ?? 'attach-exited')
    const firstCode = await openFailed({
      deps,
      targetId: FAILED_ID,
      state: await loadState(deps),
      workflowName: 'three-step',
      cliArgs: {},
      opts: TWO_PANE_OPTS,
      hostFactory: firstFactory,
      loaded: { executor: wf, config: { workflows: {} } },
    })
    expect(firstCode).toBe(EXIT.OK)
    const completed = await deps.stateStore.loadRun(FAILED_ID)
    expect(completed?.status).toBe('completed') // failed → completed
    const invocationsAfterContinue = step2.invocationCount

    // Second, independent process: a fresh `orch resume <same-id>` resolves the
    // run from the registry, re-loads its now-`completed` state, and takes the
    // read-only branch — proven by the `(completed) … read-only view` banner the
    // routing emits and an untouched runner boundary.
    const reopenHost = makeScriptedHost('quit')
    captureStderr()
    const reopenCode = await resumeCmd(deps, FAILED_ID, {}, TWO_PANE_OPTS, async () => reopenHost)

    expect(reopenCode).toBe(EXIT.OK) // loads cleanly, no corruption error
    expect(stderr).toContain('(completed)') // routed by status, not hand-passed
    expect(stderr).toContain('read-only view') // the read-only branch, not openFailed
    expect(reopenHost.runnerTouched()).toBe(false) // read-only: nothing re-ran
    expect(step2.invocationCount).toBe(invocationsAfterContinue) // runner boundary unchanged
    const stillDone = await deps.stateStore.loadRun(FAILED_ID)
    expect(stillDone?.status).toBe('completed') // unchanged by the reopen
  })
})

describe('resumeCmd — failed branch routing (integration)', () => {
  it('refuses an explicit failed run with no two-pane terminal and never re-runs (AT-20 failed half)', async () => {
    const { deps } = await setup()
    const statePath = `${tmpDir}/${FAILED_ID}/state.json`
    const before = await fs.readFile(statePath, 'utf-8')
    const host = makeScriptedHost('quit')
    const hostFactory: HostFactory = async () => host

    const code = await resumeCmd(deps, FAILED_ID, {}, PLAIN_OPTS, hostFactory)

    expect(code).toBe(EXIT.CONFIG_ERROR) // refused, not CANNOT_RESUME (AT-6)
    expect(host.runnerTouched()).toBe(false) // no silent re-run
    expect(await fs.readFile(statePath, 'utf-8')).toBe(before) // no mutation
  })
})
