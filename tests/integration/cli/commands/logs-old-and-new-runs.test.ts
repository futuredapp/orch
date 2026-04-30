// ---------------------------------------------------------------------------
// `orch logs <runId>` — backwards-compatible read path.
// ---------------------------------------------------------------------------
//
// The Phase 2 path move relocated the per-step transcript from
// `steps/<step>.transcript.ndjson` to `logs/agents/<step>/events.ndjson`.
// `state.json` carries the path as a literal string, so old and new runs
// keep working through the same command. This test locks the contract by
// driving `logsCmd` against two hand-built fixtures.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { logsCmd } from '../../../../src/cli/commands/logs.ts'
import type { CliDeps } from '../../../../src/cli/deps.ts'
import { EXIT } from '../../../../src/cli/main.ts'
import { createNullSessionLogger } from '../../../../src/observability/index.ts'
import {
  BunFsService,
  FakeClock,
  FakeGitService,
  FakeProcessService,
  path,
} from '../../../../src/services/index.ts'
import { FileRunRegistry, FileStateStore, type RunId } from '../../../../src/state/index.ts'
import { makeStepEntry } from '../../../helpers/make-step-entry.ts'

let tmpDir: string

afterEach(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

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
  }
}

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

const TERMINAL_LINE = '{"kind":"terminal","type":"turn-complete","data":null}\n'

describe('orch logs — backwards-compat read path', () => {
  it('reads a NEW run with transcriptPath at logs/agents/<step>/events.ndjson', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-logs-newrun-')
    const deps = makeDeps()
    const rid = 'r-2026-04-29-000000-nr' as RunId

    await deps.stateStore.initRun(rid, { workflowName: 'demo', startedAt: 1000 })
    const transcriptPath = `logs/agents/demo/events.ndjson`
    await deps.stateStore.saveStep(
      rid,
      makeStepEntry({
        name: 'demo',
        startedAt: 1000,
        endedAt: 2000,
        transcriptPath,
        transcriptEventCount: 1,
      }),
    )
    await deps.stateStore.setStatus(rid, 'completed', 5000)

    // Materialize the per-step folder and the events.ndjson sibling.
    const runDir = join(tmpDir, rid)
    await fs.mkdir(join(runDir, 'logs', 'agents', 'demo'), { recursive: true })
    await fs.writeFile(join(runDir, 'logs', 'agents', 'demo', 'events.ndjson'), TERMINAL_LINE)

    const out = captureStdout()
    try {
      const code = await logsCmd(deps, rid)
      expect(code).toBe(EXIT.OK)
    } finally {
      out.restore()
    }
    // The terminal/turn-complete event renders as a `done` block — its
    // presence in stdout proves the CLI read and parsed the sidecar.
    expect(out.text()).toContain('── done ──')
  })

  it('reads an OLD run with transcriptPath at steps/<step>.transcript.ndjson', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-logs-oldrun-')
    const deps = makeDeps()
    const rid = 'r-2026-04-01-000000-or' as RunId

    await deps.stateStore.initRun(rid, { workflowName: 'demo', startedAt: 1000 })
    const transcriptPath = `steps/demo.transcript.ndjson`
    await deps.stateStore.saveStep(
      rid,
      makeStepEntry({
        name: 'demo',
        startedAt: 1000,
        endedAt: 2000,
        transcriptPath,
        transcriptEventCount: 1,
      }),
    )
    await deps.stateStore.setStatus(rid, 'completed', 5000)

    const runDir = join(tmpDir, rid)
    await fs.mkdir(join(runDir, 'steps'), { recursive: true })
    await fs.writeFile(join(runDir, 'steps', 'demo.transcript.ndjson'), TERMINAL_LINE)

    const out = captureStdout()
    try {
      const code = await logsCmd(deps, rid)
      expect(code).toBe(EXIT.OK)
    } finally {
      out.restore()
    }
    // The terminal/turn-complete event renders as a `done` block — its
    // presence in stdout proves the CLI read and parsed the sidecar.
    expect(out.text()).toContain('── done ──')
  })
})
