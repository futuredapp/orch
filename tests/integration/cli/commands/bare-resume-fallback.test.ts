// Integration coverage for the status-aware bare-resume fallback (plan U7 / D5).
//
// Bare `orch resume` (no id) prefers a resumable (`crashed`/`running`) run and
// never offers a finished one when a resumable exists (AT-9). With only
// finished runs and an interactive two-pane terminal, it confirms before
// opening the newest finished run, and the confirmation copy distinguishes the
// open kind — read-only (completed) vs the interactive failure view (failed)
// (AT-10). Confirming opens the matching view (AT-11); declining opens nothing
// (AT-12). With no two-pane terminal it keeps today's "no resumable run found",
// never prompting (D8 guard).

import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import { writeFinishedRun } from '@orch/test/finished-run-fixture.ts'
import { resumeCmd } from '../../../../src/cli/commands/resume.ts'
import type { CliDeps } from '../../../../src/cli/deps.ts'
import { type CliOpts, EXIT, type HostFactory } from '../../../../src/cli/main.ts'
import type {
  ForegroundShutdownReason,
  Host,
  HostReachability,
  PaneAttachment,
  PaneRole,
} from '../../../../src/hosts/index.ts'
import { createNullSessionLogger } from '../../../../src/observability/index.ts'
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

function makeDeps(confirm: FakeConfirmService): CliDeps {
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
    confirmService: confirm,
    isStdinTty: true,
  }
}

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

// A finished-run open never executes, so the host factory only needs a host
// that settles its foreground immediately (the user pressing `q`).
const VIEWER_HOST_FACTORY: HostFactory = async () => {
  const host: Host = {
    get mode() {
      return 'two-pane' as const
    },
    writeBanner(): void {},
    onRunnerEvent(): void {},
    onLifecycleEvent(): void {},
    onCommandLine(): void {},
    async attach(pane: PaneRole): Promise<PaneAttachment> {
      return { pane, async detach() {} }
    },
    async runInteractive() {
      return { exitCode: 0, durationMs: 0 }
    },
    async attachForeground(): Promise<void> {},
    async awaitForegroundShutdown(): Promise<ForegroundShutdownReason> {
      return 'quit'
    },
    async probeReachability(): Promise<HostReachability> {
      return { reachable: true }
    },
    async teardown(): Promise<void> {},
  }
  return host
}

const THROWING_HOST_FACTORY: HostFactory = async () => {
  throw new Error('host factory must not be reached on this path')
}

// Run ids are timestamp-prefixed and listed ascending, so the lexicographically
// largest id is the "most recent" run the fallback offers.
const OLDER_COMPLETED_ID = 'r-2026-06-09-100000-aa' as RunId
const RESUMABLE_CRASHED_ID = 'r-2026-06-09-200000-bb' as RunId
const NEWEST_COMPLETED_ID = 'r-2026-06-09-300000-cc' as RunId
const NEWEST_FAILED_ID = 'r-2026-06-09-400000-dd' as RunId
const CORRUPT_NEWEST_ID = 'r-2026-06-09-500000-ee' as RunId

// Seed a run directory whose `state.json` is unparseable, so `loadRun` throws
// `StateCorruptionError`. Lives under `<tmpDir>/<runId>/` to match the
// `FileStateStore`/`FileRunRegistry` layout the deps are built on.
async function writeCorruptRun(runId: RunId): Promise<void> {
  await fs.mkdir(`${tmpDir}/${runId}`, { recursive: true })
  await fs.writeFile(`${tmpDir}/${runId}/state.json`, '{ broken json')
}

describe('bare resume — status-aware finished-run fallback (integration)', () => {
  it('prefers a resumable run and never offers a finished one (AT-9)', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-bare-resume-')
    captureStderr()
    // An unscripted confirm throws — so reaching it would fail the test.
    const confirm = new FakeConfirmService()
    const deps = makeDeps(confirm)
    await writeFinishedRun(deps.stateStore, {
      runId: OLDER_COMPLETED_ID,
      status: 'completed',
      workflowName: 'demo',
    })
    await writeFinishedRun(deps.stateStore, {
      runId: RESUMABLE_CRASHED_ID,
      status: 'crashed',
      workflowName: 'demo',
    })

    // The resumable (crashed) run takes the real resume path, which fails at
    // loadWorkflow (no orch.config.ts in the temp cwd) → CONFIG_ERROR. That it
    // reached resume (not the fallback) is the point.
    const code = await resumeCmd(deps, '', {}, TWO_PANE_OPTS, THROWING_HOST_FACTORY)

    expect(code).toBe(EXIT.CONFIG_ERROR)
    expect(stderr).toContain('Resuming run')
    expect(confirm.recorded()).toHaveLength(0)
    expect(stderr.toLowerCase()).not.toContain('open it')
  })

  it('confirms before opening the newest finished run, naming it + read-only kind (AT-10 completed)', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-bare-resume-')
    captureStderr()
    const confirm = new FakeConfirmService([false]) // decline so nothing opens
    const deps = makeDeps(confirm)
    await writeFinishedRun(deps.stateStore, {
      runId: NEWEST_COMPLETED_ID,
      status: 'completed',
      workflowName: 'deploy',
    })

    const code = await resumeCmd(deps, '', {}, TWO_PANE_OPTS, THROWING_HOST_FACTORY)

    expect(code).toBe(EXIT.OK)
    const calls = confirm.recorded()
    expect(calls).toHaveLength(1)
    const question = calls[0]?.question ?? ''
    expect(question).toContain(NEWEST_COMPLETED_ID) // names the run
    expect(question).toContain('deploy') // names the workflow
    expect(question).toContain('completed') // names the status
    expect(question).toContain('read-only') // distinguishes the open kind
    expect(question).not.toContain('interactive failure view')
  })

  it('names the interactive failure view as the open kind for a failed run (AT-10 failed)', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-bare-resume-')
    captureStderr()
    const confirm = new FakeConfirmService([false]) // decline so nothing opens
    const deps = makeDeps(confirm)
    // The fixture builder models completed/crashed/running; stamp `failed`
    // directly for the copy assertion (decline path never opens the view).
    await deps.stateStore.initRun(NEWEST_FAILED_ID, { workflowName: 'deploy', startedAt: 1000 })
    await deps.stateStore.setStatus(NEWEST_FAILED_ID, 'failed', 2000)

    const code = await resumeCmd(deps, '', {}, TWO_PANE_OPTS, THROWING_HOST_FACTORY)

    expect(code).toBe(EXIT.OK)
    const question = confirm.recorded()[0]?.question ?? ''
    expect(question).toContain(NEWEST_FAILED_ID)
    expect(question).toContain('failed')
    expect(question).toContain('interactive failure view (retry/continue available)')
  })

  it('opens the newest finished run read-only when confirmed, exiting 0 (AT-11)', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-bare-resume-')
    captureStderr()
    const confirm = new FakeConfirmService([true]) // confirm → open
    const deps = makeDeps(confirm)
    await writeFinishedRun(deps.stateStore, {
      runId: NEWEST_COMPLETED_ID,
      status: 'completed',
      workflowName: 'deploy',
    })

    const code = await resumeCmd(deps, '', {}, TWO_PANE_OPTS, VIEWER_HOST_FACTORY)

    expect(code).toBe(EXIT.OK)
    expect(confirm.recorded()).toHaveLength(1)
    expect(stderr).toContain('read-only view') // openFinished was reached
  })

  it('opens nothing and reports "nothing to resume" when declined (AT-12)', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-bare-resume-')
    captureStderr()
    const confirm = new FakeConfirmService([false]) // decline
    const deps = makeDeps(confirm)
    await writeFinishedRun(deps.stateStore, {
      runId: NEWEST_COMPLETED_ID,
      status: 'completed',
      workflowName: 'deploy',
    })

    const code = await resumeCmd(deps, '', {}, TWO_PANE_OPTS, THROWING_HOST_FACTORY)

    expect(code).toBe(EXIT.OK)
    expect(stderr.toLowerCase()).toContain('nothing to resume')
  })

  it('skips a corrupt most-recent run and still offers the finished-run fallback (L3)', async () => {
    // Regression for L3: `findResumableRun` used to `loadRun` with no try/catch,
    // so a `StateCorruptionError` on the most-recent run aborted bare resume
    // before it ever reached the finished-run fallback that `findNewestFinishedRunId`
    // (which already skips corruption) powers. The corrupt run is the NEWEST, so
    // it is scanned first; the fix must skip it, not throw.
    tmpDir = await fs.mkdtemp('/tmp/orch-bare-resume-')
    captureStderr()
    const confirm = new FakeConfirmService([false]) // decline so nothing opens
    const deps = makeDeps(confirm)
    await writeFinishedRun(deps.stateStore, {
      runId: NEWEST_COMPLETED_ID,
      status: 'completed',
      workflowName: 'deploy',
    })
    await writeCorruptRun(CORRUPT_NEWEST_ID)

    const code = await resumeCmd(deps, '', {}, TWO_PANE_OPTS, THROWING_HOST_FACTORY)

    // The scan did not throw; the fallback was offered for the newest *openable*
    // finished run, not the corrupt one.
    expect(code).toBe(EXIT.OK)
    const calls = confirm.recorded()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.question ?? '').toContain(NEWEST_COMPLETED_ID)
    expect(calls[0]?.question ?? '').not.toContain(CORRUPT_NEWEST_ID)
  })

  it('never prompts with no two-pane terminal, even with finished runs (D8 / AT-21 guard)', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-bare-resume-')
    captureStderr()
    const confirm = new FakeConfirmService() // unscripted → throws if reached
    const deps = makeDeps(confirm)
    await writeFinishedRun(deps.stateStore, {
      runId: NEWEST_COMPLETED_ID,
      status: 'completed',
      workflowName: 'deploy',
    })

    const code = await resumeCmd(deps, '', {}, PLAIN_OPTS, THROWING_HOST_FACTORY)

    expect(code).toBe(EXIT.CANNOT_RESUME)
    expect(stderr).toContain('No resumable run found')
    expect(confirm.recorded()).toHaveLength(0)
  })
})
