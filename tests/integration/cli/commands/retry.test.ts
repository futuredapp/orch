// Integration coverage for the `orch retry <id>` verb (plan U8).
//
// Drives the REAL `retryCmd` / `retryRun` over a real `FileStateStore` +
// `FakeRunner`, asserting the external boundary (exit code, stderr, on-disk
// `state.json`, runner boundary, ConfirmService construction counter). The
// `failed` state is produced by actually executing a three-step workflow whose
// middle step fails, exactly as the `open-failed` harness does, so the retry
// re-runs the way it would in production.
//
// Covers: AT-R6 (failed → opens + auto retry-and-continue to completion),
// AT-R7 (non-failed rejected, ×3 statuses), AT-R8 (headless runs the default,
// never blocks, exit reflects outcome, no ConfirmService), AT-R9 (prefix
// resolution shared with `resume`: ambiguous + not-found), AT-R10 cross-verb
// (after a retry, a later read-only reopen loads cleanly and re-runs nothing).

import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import { createFakeHost } from '@orch/test/fake-host.ts'
import { writeFinishedRun } from '@orch/test/finished-run-fixture.ts'
import { resumeCmd } from '../../../../src/cli/commands/resume.ts'
import { retryCmd, retryRun } from '../../../../src/cli/commands/retry.ts'
import type { CliDeps } from '../../../../src/cli/deps.ts'
import { type CliOpts, EXIT, type HostFactory } from '../../../../src/cli/main.ts'
import { noRetry } from '../../../../src/core/index.ts'
import { step } from '../../../../src/core/step.ts'
import type { WorkflowDeps } from '../../../../src/core/workflow.ts'
import { workflow } from '../../../../src/core/workflow.ts'
import type {
  ForegroundShutdownReason,
  Host,
  HostReachability,
  PaneAttachment,
  PaneRole,
} from '../../../../src/hosts/index.ts'
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

const FAILED_ID = 'r-2026-06-09-800001-ff' as RunId

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

// A fake host whose foreground settles with a scripted reason. `retryRun` builds
// exactly one host (via `runResumeExecution`), so a single reason suffices —
// `attach-exited` models the foreground detaching once the workflow completes.
function makeScriptedHost(
  reason: ForegroundShutdownReason,
  mode: 'two-pane' | 'plain' = 'two-pane',
): Host & { runnerTouched: () => boolean } {
  let touched = false
  const fake = createFakeHost({ mode })
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
    async attachForeground(): Promise<void> {},
    async awaitForegroundShutdown(): Promise<ForegroundShutdownReason> {
      return reason
    },
    async probeReachability(): Promise<HostReachability> {
      return { reachable: true }
    },
    async teardown(): Promise<void> {},
    runnerTouched: () => touched,
  }
}

const THROWING_HOST_FACTORY: HostFactory = async () => {
  throw new Error('host factory must not be reached on a rejection/resolution path')
}

function makeConfirmSpy(): FakeConfirmService & { calls: () => number } {
  let count = 0
  const fake = new FakeConfirmService()
  const original = fake.confirm.bind(fake)
  fake.confirm = async (...a) => {
    count += 1
    return original(...a)
  }
  return Object.assign(fake, { calls: () => count })
}

// Builds CliDeps + the matching execute() WorkflowDeps over one shared
// FileStateStore / FakeProcessService, drives a three-step workflow to `failed`
// (middle step fails), and returns the pieces the retry tests script.
async function setup(confirmService?: FakeConfirmService): Promise<{
  readonly deps: CliDeps
  readonly wf: ReturnType<typeof workflow>
  readonly step2: FakeRunner
}> {
  tmpDir = await fs.mkdtemp('/tmp/orch-retry-')
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
    confirmService: confirmService ?? new FakeConfirmService(),
    isStdinTty: true,
  }

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

describe('orch retry — auto retry-and-continue (integration)', () => {
  it('opens a failed run and auto-runs retry-and-continue to completion (AT-R6)', async () => {
    const { deps, wf, step2 } = await setup()
    step2.script({ structuredOutput: 'two-ok' }) // the continue re-run passes
    const state = await loadState(deps)

    const host = makeScriptedHost('attach-exited')
    const code = await retryRun({
      deps,
      targetId: FAILED_ID,
      state,
      workflowName: 'three-step',
      cliArgs: {},
      opts: TWO_PANE_OPTS,
      hostFactory: async () => host,
      loaded: { executor: wf, config: { workflows: {} } },
    })

    expect(code).toBe(EXIT.OK)
    const done = await deps.stateStore.loadRun(FAILED_ID)
    expect(done?.status).toBe('completed') // failed → completed, no keypress
    expect(done?.steps.step2?.value).toBe('two-ok') // failed step re-ran
    expect(done?.steps.step3?.value).toBe('three-ok') // continued to the end
  })

  it('headless retry runs the configured default, never blocks, and exits 0 on success (AT-R8)', async () => {
    const confirm = makeConfirmSpy()
    const { deps, wf, step2 } = await setup(confirm)
    step2.script({ structuredOutput: 'two-ok' })
    const state = await loadState(deps)

    const host = makeScriptedHost('attach-exited', 'plain')
    const code = await retryRun({
      deps,
      targetId: FAILED_ID,
      state,
      workflowName: 'three-step',
      cliArgs: {},
      opts: PLAIN_OPTS,
      hostFactory: async () => host,
      loaded: { executor: wf, config: { workflows: {} } },
    })

    expect(code).toBe(EXIT.OK)
    expect(confirm.calls()).toBe(0) // never prompts — no override, no ConfirmService
    const done = await deps.stateStore.loadRun(FAILED_ID)
    expect(done?.status).toBe('completed')
  })

  it('headless retry that fails again exits non-zero and leaves the run failed (AT-R8 outcome)', async () => {
    const { deps, wf, step2 } = await setup()
    step2.script({ failWith: { message: 'boom-again', exitCode: 7 } }) // retry fails again
    const state = await loadState(deps)

    const host = makeScriptedHost('attach-exited', 'plain')
    const code = await retryRun({
      deps,
      targetId: FAILED_ID,
      state,
      workflowName: 'three-step',
      cliArgs: {},
      opts: PLAIN_OPTS,
      hostFactory: async () => host,
      loaded: { executor: wf, config: { workflows: {} } },
    })

    expect(code).not.toBe(EXIT.OK) // exit reflects the failed-again outcome
    const after = await deps.stateStore.loadRun(FAILED_ID)
    expect(after?.status).toBe('failed')
    expect(after?.steps.step3).toBeUndefined() // never reached the later step
  })

  it('after a retry to completion, a later `orch resume` re-routes the now-completed run to the read-only viewer (AT-R10)', async () => {
    // H2: the reopen drives the REAL `resumeCmd` — which re-loads the now-
    // `completed` state from disk and *decides* the read-only branch — rather
    // than calling `openFinished` with a hand-passed `status`. Calling the leaf
    // directly bypassed exactly the cross-verb routing AT-R10 protects: that
    // after an `orch retry`, a later `orch resume <same-id>` re-routes the run
    // to the read-only viewer (not `openFailed`/a re-run).
    const { deps, wf, step2 } = await setup()
    step2.script({ structuredOutput: 'two-ok' })
    const state = await loadState(deps)

    const firstHost = makeScriptedHost('attach-exited')
    const firstCode = await retryRun({
      deps,
      targetId: FAILED_ID,
      state,
      workflowName: 'three-step',
      cliArgs: {},
      opts: TWO_PANE_OPTS,
      hostFactory: async () => firstHost,
      loaded: { executor: wf, config: { workflows: {} } },
    })
    expect(firstCode).toBe(EXIT.OK)
    const completed = await deps.stateStore.loadRun(FAILED_ID)
    expect(completed?.status).toBe('completed')
    const invocationsAfterRetry = step2.invocationCount

    // A fresh `orch resume <same-id>` resolves the run from the registry,
    // re-loads its now-`completed` state, and takes the read-only branch —
    // proven by the `(completed) … read-only view` banner the routing emits and
    // an untouched runner boundary.
    const reopenHost = makeScriptedHost('quit')
    captureStderr()
    const reopenCode = await resumeCmd(deps, FAILED_ID, {}, TWO_PANE_OPTS, async () => reopenHost)

    expect(reopenCode).toBe(EXIT.OK) // loads cleanly, no corruption error
    expect(stderr).toContain('(completed)') // routed by status, not hand-passed
    expect(stderr).toContain('read-only view') // the read-only branch, not openFailed
    expect(reopenHost.runnerTouched()).toBe(false) // read-only: nothing re-ran
    expect(step2.invocationCount).toBe(invocationsAfterRetry) // runner boundary unchanged
    const stillDone = await deps.stateStore.loadRun(FAILED_ID)
    expect(stillDone?.status).toBe('completed')
  })
})

describe('orch retry — rejection + resolution (integration)', () => {
  function makeDeps(): CliDeps {
    const bunFs = new BunFsService()
    const basePath = path(tmpDir)
    return {
      processService: new FakeProcessService(),
      fsService: bunFs,
      gitService: new FakeGitService(),
      clock: new FakeClock(1000),
      stateStore: new FileStateStore({ fs: bunFs, basePath }),
      registry: new FileRunRegistry({ fs: bunFs, basePath }),
      cwd: path(tmpDir),
      statePath: basePath,
      debug: false,
      sessionLoggerFor: (rid) => createNullSessionLogger({ runId: rid }),
      promptServiceFor: () => new FakePromptService(),
      confirmService: new FakeConfirmService(),
      isStdinTty: true,
    }
  }

  let stderr: string
  let restoreStderr: (() => void) | undefined

  afterEach(() => {
    restoreStderr?.()
    restoreStderr = undefined
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

  for (const status of ['completed', 'crashed', 'running'] as const) {
    it(`rejects a ${status} run, names its status, exits non-zero, never opens (AT-R7)`, async () => {
      tmpDir = await fs.mkdtemp('/tmp/orch-retry-reject-')
      captureStderr()
      const deps = makeDeps()
      const rid = `r-2026-04-13-100000-${status[0]}${status[1]}` as RunId
      await writeFinishedRun(deps.stateStore, { runId: rid, status, workflowName: 'demo' })

      const code = await retryCmd(deps, rid, {}, TWO_PANE_OPTS, THROWING_HOST_FACTORY)

      expect(code).not.toBe(EXIT.OK)
      expect(stderr).toContain(rid)
      expect(stderr).toContain(status)
      expect(stderr.toLowerCase()).toContain('only')
    })
  }

  it('reports a not-found prefix like resume does (AT-R9 not-found)', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-retry-prefix-')
    captureStderr()
    const deps = makeDeps()

    const code = await retryCmd(deps, 'r-9999-nope', {}, TWO_PANE_OPTS, THROWING_HOST_FACTORY)

    expect(code).toBe(EXIT.CANNOT_RESUME)
    expect(stderr).toContain('No run found matching')
  })

  it('reports an ambiguous prefix like resume does (AT-R9 ambiguous)', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-retry-prefix-')
    captureStderr()
    const deps = makeDeps()
    // Status is irrelevant here — resolution fails before the status gate
    // because the prefix matches two runs. Use a fixture-supported status.
    const a = 'r-2026-04-13-111111-aa' as RunId
    const b = 'r-2026-04-13-111111-bb' as RunId
    await writeFinishedRun(deps.stateStore, { runId: a, status: 'completed', workflowName: 'demo' })
    await writeFinishedRun(deps.stateStore, { runId: b, status: 'completed', workflowName: 'demo' })

    const code = await retryCmd(
      deps,
      'r-2026-04-13-111111',
      {},
      TWO_PANE_OPTS,
      THROWING_HOST_FACTORY,
    )

    expect(code).toBe(EXIT.CANNOT_RESUME)
    expect(stderr).toContain('Ambiguous run ID prefix')
  })

  it('treats a bare `orch retry` (no id) as a usage error (no auto-discovery)', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-retry-bare-')
    captureStderr()
    const deps = makeDeps()

    const code = await retryCmd(deps, '', {}, TWO_PANE_OPTS, THROWING_HOST_FACTORY)

    expect(code).not.toBe(EXIT.OK)
    expect(stderr).toContain('retry requires a run id')
  })
})
