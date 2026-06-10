// Integration coverage for `resumeCmd`'s finished-run routing (plan U1/U3).
//
// `completed` runs route to the read-only viewer instead of throwing
// `ResumeError`; with no two-pane terminal the open is refused (status-named,
// non-zero, no mutation). `crashed`/`running`/bare/ambiguous paths are
// regression-guarded so the new branch cannot silently divert them.
// Covers AT-6, AT-7, AT-8, AT-20 (completed half), AT-21.

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

const PLAIN_OPTS: CliOpts = {
  mode: 'plain',
  format: 'text',
  noAttach: false,
  debug: false,
  interactivity: 'interactive',
  latest: false,
  step: undefined,
  follow: false,
  watch: false,
}

const TWO_PANE_OPTS: CliOpts = { ...PLAIN_OPTS, mode: 'two-pane' }

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
  throw new Error('host factory must not be reached on a refusal/regression path')
}

interface ViewerSpyHost extends Host {
  readonly attachedForeground: () => boolean
  readonly runnerTouched: () => boolean
}

// A read-only viewer host that records whether the foreground was actually
// attached (the viewer launched) and whether any runner surface was touched.
// Lets the AT-1 routing test assert the behavior — viewer attached, no step ran
// — instead of an stderr copy literal that a viewer rendering nothing would
// still satisfy.
function makeViewerSpyHost(): ViewerSpyHost {
  let attached = false
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
    async teardown(): Promise<void> {},
    attachedForeground: () => attached,
    runnerTouched: () => runnerTouched,
  }
}

async function seedRun(deps: CliDeps, rid: RunId, status: 'completed' | 'crashed' | 'running') {
  await writeFinishedRun(deps.stateStore, { runId: rid, status, workflowName: 'demo' })
}

const COMPLETED_ID = 'r-2026-04-13-438944-09' as RunId
const CRASHED_ID = 'r-2026-04-13-216568-id' as RunId
const RUNNING_ID = 'r-2026-04-13-760704-6a' as RunId

describe('resumeCmd finished-run routing (integration)', () => {
  it('refuses an explicit completed run with no two-pane terminal, naming the run + status (AT-20)', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-resume-finished-')
    captureStderr()
    const deps = makeDeps()
    await seedRun(deps, COMPLETED_ID, 'completed')
    const statePath = `${tmpDir}/${COMPLETED_ID}/state.json`
    const before = await fs.readFile(statePath, 'utf-8')

    const code = await resumeCmd(deps, COMPLETED_ID, {}, PLAIN_OPTS, THROWING_HOST_FACTORY)

    expect(code).not.toBe(EXIT.OK)
    expect(stderr).toContain(COMPLETED_ID)
    expect(stderr).toContain('completed')
    expect(await fs.readFile(statePath, 'utf-8')).toBe(before)
  })

  it('never reports "cannot resume" for a finished run (AT-6)', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-resume-finished-')
    captureStderr()
    const deps = makeDeps()
    await seedRun(deps, COMPLETED_ID, 'completed')

    const code = await resumeCmd(deps, COMPLETED_ID, {}, PLAIN_OPTS, THROWING_HOST_FACTORY)

    expect(code).not.toBe(EXIT.CANNOT_RESUME)
    expect(stderr.toLowerCase()).not.toContain('cannot resume')
  })

  it('routes a completed run to the read-only viewer and actually launches it, not just an stderr branch (AT-1/AT-6 routing)', async () => {
    // H1: the prior version asserted only `stderr` contained 'read-only view' —
    // the literal `process.stderr.write` at the top of `openFinished`, which a
    // viewer that rendered nothing would still print. Assert the *behavior*: the
    // viewer's foreground was attached (so it survives a copy change) and no step
    // executed (read-only). The rendered-view assertion lives in the gated
    // real-tmux test the AT-1 status row points at.
    tmpDir = await fs.mkdtemp('/tmp/orch-resume-finished-')
    captureStderr()
    const deps = makeDeps()
    await seedRun(deps, COMPLETED_ID, 'completed')
    const host = makeViewerSpyHost()

    const code = await resumeCmd(deps, COMPLETED_ID, {}, TWO_PANE_OPTS, async () => host)

    expect(code).toBe(EXIT.OK)
    expect(host.attachedForeground()).toBe(true) // viewer actually launched
    expect(host.runnerTouched()).toBe(false) // read-only: no step executed
  })

  it('does not divert a crashed run into the open/refuse branch (AT-7 regression)', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-resume-finished-')
    captureStderr()
    const deps = makeDeps()
    await seedRun(deps, CRASHED_ID, 'crashed')

    // No orch.config.ts in the temp cwd, so the resume path fails at
    // loadWorkflow with CONFIG_ERROR — proof it reached the real resume path
    // rather than the completed open/refusal branch.
    const code = await resumeCmd(deps, CRASHED_ID, {}, PLAIN_OPTS, VIEWER_HOST_FACTORY)

    expect(code).toBe(EXIT.CONFIG_ERROR)
    expect(stderr).toContain('Resuming run')
    expect(stderr).not.toContain('read-only view')
  })

  it('does not divert a running run into the open/refuse branch (AT-8 regression)', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-resume-finished-')
    captureStderr()
    const deps = makeDeps()
    await seedRun(deps, RUNNING_ID, 'running')

    const code = await resumeCmd(deps, RUNNING_ID, {}, PLAIN_OPTS, VIEWER_HOST_FACTORY)

    expect(code).toBe(EXIT.CONFIG_ERROR)
    expect(stderr).toContain('Resuming run')
    expect(stderr).not.toContain('read-only view')
  })

  it('bare resume with only finished runs reports "nothing to resume" without a prompt (AT-21)', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-resume-finished-')
    captureStderr()
    const deps = makeDeps()
    await seedRun(deps, COMPLETED_ID, 'completed')

    const code = await resumeCmd(deps, '', {}, PLAIN_OPTS, THROWING_HOST_FACTORY)

    expect(code).toBe(EXIT.CANNOT_RESUME)
    expect(stderr).toContain('No resumable run found')
    expect(stderr.toLowerCase()).not.toContain('[y/n]')
  })
})
