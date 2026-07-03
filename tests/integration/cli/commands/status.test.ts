import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import { makeStepEntry } from '@orch/test/make-step-entry.ts'
import { statusCmd } from '../../../../src/cli/commands/status.ts'
import type { CliDeps } from '../../../../src/cli/deps.ts'
import { glyphs } from '../../../../src/cli/format.ts'
import { EXIT } from '../../../../src/cli/main.ts'
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

// Mirror the module-level glyph choice in status.ts, which resolves the glyph
// set from the process's TTY at import time.
const GLYPH_COMPLETED = glyphs(process.stdout.isTTY ?? false).completed

afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

interface OutCapture {
  readonly text: () => string
  readonly restore: () => void
}

function captureStdout(): OutCapture {
  const chunks: string[] = []
  const original = process.stdout.write.bind(process.stdout)
  // biome-ignore lint/suspicious/noExplicitAny: monkey-patching for test capture
  ;(process.stdout as any).write = (chunk: any): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString())
    return true
  }
  return {
    text: () => chunks.join(''),
    restore: () => {
      // biome-ignore lint/suspicious/noExplicitAny: restore original
      ;(process.stdout as any).write = original
    },
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
    cwd: path('/workspace'),
    statePath: basePath,
    debug: false,
    sessionLoggerFor: (rid) => createNullSessionLogger({ runId: rid }),
    promptServiceFor: () => new FakePromptService(),
    confirmService: new FakeConfirmService(),
    isStdinTty: true,
  }
}

describe('statusCmd (integration)', () => {
  it('returns EXIT.CONFIG_ERROR when no id argument is given', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-status-test-')
    const deps = makeDeps()

    const code = await statusCmd(deps, '')

    expect(code).toBe(EXIT.CONFIG_ERROR)
  })

  it('returns EXIT.CONFIG_ERROR when run is not found', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-status-test-')
    const deps = makeDeps()

    const code = await statusCmd(deps, 'r-2026-04-13-020688-q5')

    expect(code).toBe(EXIT.CONFIG_ERROR)
  })

  it('returns EXIT.OK and displays a completed run with steps', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-status-test-')
    const deps = makeDeps()

    const rid = 'r-2026-04-13-438944-09' as RunId
    await deps.stateStore.initRun(rid, { workflowName: 'deploy', startedAt: 1000 })
    await deps.stateStore.saveStep(
      rid,
      makeStepEntry({ name: 'plan', startedAt: 1000, endedAt: 2000 }),
    )
    await deps.stateStore.setStatus(rid, 'completed', 5000)

    const code = await statusCmd(deps, 'r-2026-04-13-438944-09')

    expect(code).toBe(EXIT.OK)
  })

  it('resolves a partial run ID prefix', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-status-test-')
    const deps = makeDeps()

    const rid = 'r-2026-04-13-438944-09' as RunId
    await deps.stateStore.initRun(rid, { startedAt: 1000 })

    const code = await statusCmd(deps, 'r-2026-04-13-438')

    expect(code).toBe(EXIT.OK)
  })

  it('returns EXIT.CONFIG_ERROR for ambiguous prefix', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-status-test-')
    const deps = makeDeps()

    const rid1 = 'r-2026-04-13-438944-09' as RunId
    const rid2 = 'r-2026-04-13-216568-id' as RunId
    await deps.stateStore.initRun(rid1, { startedAt: 1000 })
    await deps.stateStore.initRun(rid2, { startedAt: 2000 })

    const code = await statusCmd(deps, 'r-2026-04-13-abc')

    expect(code).toBe(EXIT.CONFIG_ERROR)
  })

  it('names the failing step and reason from lifecycle.ndjson for a failed run', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-status-test-')
    const deps = makeDeps()

    const rid = 'r-2026-04-13-438944-09' as RunId
    await deps.stateStore.initRun(rid, { workflowName: 'deploy', startedAt: 1000 })
    await deps.stateStore.saveStep(
      rid,
      makeStepEntry({ name: 'plan', startedAt: 1000, endedAt: 2000 }),
    )
    await deps.stateStore.setStatus(rid, 'failed', 5000)
    const logsDir = `${deps.stateStore.runDir(rid)}/logs`
    await fs.mkdir(logsDir, { recursive: true })
    await fs.writeFile(
      `${logsDir}/lifecycle.ndjson`,
      `${JSON.stringify({ type: 'step:start', stepName: 'build' })}\n${JSON.stringify({
        type: 'step:failed',
        stepName: 'build',
        error: { message: 'exit code 1' },
      })}\n`,
    )

    const out = captureStdout()
    let code: number
    try {
      code = await statusCmd(deps, 'r-2026-04-13-438944-09')
    } finally {
      out.restore()
    }

    expect(code).toBe(EXIT.OK)
    expect(out.text()).toContain('Failed step: build')
    expect(out.text()).toContain('Reason:      exit code 1')
    expect(out.text()).toContain('Details:')
    expect(out.text()).toContain('logs/lifecycle.ndjson')
  })

  it('reports an unknown failing step and does not throw when the lifecycle log is absent', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-status-test-')
    const deps = makeDeps()

    const rid = 'r-2026-04-13-438944-09' as RunId
    await deps.stateStore.initRun(rid, { workflowName: 'deploy', startedAt: 1000 })
    await deps.stateStore.saveStep(
      rid,
      makeStepEntry({ name: 'plan', startedAt: 1000, endedAt: 2000 }),
    )
    await deps.stateStore.setStatus(rid, 'failed', 5000)

    const out = captureStdout()
    let code: number
    try {
      code = await statusCmd(deps, 'r-2026-04-13-438944-09')
    } finally {
      out.restore()
    }

    expect(code).toBe(EXIT.OK)
    expect(out.text()).toContain('Failed step: (unknown — see logs)')
    expect(out.text()).toContain('Details:')
    expect(out.text()).toContain('logs/lifecycle.ndjson')
  })

  it('prints no Failure section for an all-completed run', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-status-test-')
    const deps = makeDeps()

    const rid = 'r-2026-04-13-438944-09' as RunId
    await deps.stateStore.initRun(rid, { workflowName: 'deploy', startedAt: 1000 })
    await deps.stateStore.saveStep(
      rid,
      makeStepEntry({ name: 'plan', startedAt: 1000, endedAt: 2000 }),
    )
    await deps.stateStore.setStatus(rid, 'completed', 5000)

    const out = captureStdout()
    let code: number
    try {
      code = await statusCmd(deps, 'r-2026-04-13-438944-09')
    } finally {
      out.restore()
    }

    expect(code).toBe(EXIT.OK)
    expect(out.text()).toContain(`${GLYPH_COMPLETED} plan`)
    expect(out.text()).not.toContain('Failed step:')
  })

  it('displays a crashed run with zero steps', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-status-test-')
    const deps = makeDeps()

    const rid = 'r-2026-04-13-438944-09' as RunId
    await deps.stateStore.initRun(rid, { workflowName: 'fail-fast', startedAt: 1000 })
    await deps.stateStore.setStatus(rid, 'crashed', 2000)

    const code = await statusCmd(deps, 'r-2026-04-13-438944-09')

    expect(code).toBe(EXIT.OK)
  })
})
