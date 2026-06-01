// Unit tests for `orch logs` (PR B — --latest, --step, --follow).
//
// The command is wired against fakes at the `*Service` ports per
// `testing-strategy.md` rule 3 — no `mock.module`, no scripted-content
// fakes, no internal mocks. Every test assembles a real
// `FileStateStore` + `FileRunRegistry` over a `BunFsService` rooted at a
// fresh tmpdir, so we exercise the actual schema validators.

import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { logsCmd } from '../../../src/cli/commands/logs.ts'
import type { CliDeps } from '../../../src/cli/deps.ts'
import { type CliOpts, EXIT } from '../../../src/cli/main.ts'
import { createNullSessionLogger } from '../../../src/observability/index.ts'
import {
  BunFsService,
  FakeClock,
  FakeGitService,
  FakeProcessService,
  path,
} from '../../../src/services/index.ts'
import { FakeConfirmService, FakePromptService } from '../../../src/services/prompt/index.ts'
import { FileRunRegistry, FileStateStore, type RunId } from '../../../src/state/index.ts'
import { makeStepEntry } from '../../helpers/make-step-entry.ts'

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
    promptServiceFor: () => new FakePromptService(),
    confirmService: new FakeConfirmService(),
    isStdinTty: true,
  }
}

const DEFAULT_OPTS: CliOpts = {
  mode: undefined,
  format: 'text',
  noAttach: false,
  debug: false,
  interactivity: 'interactive',
  latest: false,
  step: undefined,
  follow: false,
  watch: false,
}

const opts = (overrides: Partial<CliOpts> = {}): CliOpts => ({ ...DEFAULT_OPTS, ...overrides })

const TERMINAL_LINE = '{"kind":"terminal","type":"turn-complete","data":null}\n'

interface IO {
  readonly stdout: () => string
  readonly stderr: () => string
  readonly restore: () => void
}

function capture(): IO {
  const outChunks: string[] = []
  const errChunks: string[] = []
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
  // biome-ignore lint/suspicious/noExplicitAny: monkey-patching for test capture
  ;(process.stdout as any).write = (chunk: any): boolean => {
    outChunks.push(typeof chunk === 'string' ? chunk : chunk.toString())
    return true
  }
  // biome-ignore lint/suspicious/noExplicitAny: monkey-patching for test capture
  ;(process.stderr as any).write = (chunk: any): boolean => {
    errChunks.push(typeof chunk === 'string' ? chunk : chunk.toString())
    return true
  }
  return {
    stdout: () => outChunks.join(''),
    stderr: () => errChunks.join(''),
    restore: () => {
      // biome-ignore lint/suspicious/noExplicitAny: restore original
      ;(process.stdout as any).write = origOut
      // biome-ignore lint/suspicious/noExplicitAny: restore original
      ;(process.stderr as any).write = origErr
    },
  }
}

async function seedRun(
  deps: CliDeps,
  rid: RunId,
  stepName: string,
  status: 'running' | 'completed' | 'failed' | 'crashed',
): Promise<void> {
  await deps.stateStore.initRun(rid, { workflowName: 'demo', startedAt: 1000 })
  const transcriptPath = `logs/agents/${stepName}/events.ndjson`
  await deps.stateStore.saveStep(
    rid,
    makeStepEntry({
      name: stepName,
      startedAt: 1000,
      endedAt: 2000,
      transcriptPath,
      transcriptEventCount: 1,
    }),
  )
  if (status !== 'running') await deps.stateStore.setStatus(rid, status, 5000)

  const runDir = join(tmpDir, rid)
  await fs.mkdir(join(runDir, 'logs', 'agents', stepName), { recursive: true })
  await fs.writeFile(join(runDir, 'logs', 'agents', stepName, 'events.ndjson'), TERMINAL_LINE)
}

// ---------------------------------------------------------------------------
// --latest
// ---------------------------------------------------------------------------

describe('orch logs --latest', () => {
  it('resolves to the most recent run id from the registry', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-logs-latest-')
    const deps = makeDeps()

    // Sorted lexicographically: -02 < -03, so -03 is "latest".
    await seedRun(deps, 'r-2026-04-29-000002-aa' as RunId, 'demo', 'completed')
    await seedRun(deps, 'r-2026-04-29-000003-bb' as RunId, 'demo', 'completed')

    const io = capture()
    try {
      const code = await logsCmd(deps, '', {}, opts({ latest: true }))
      expect(code).toBe(EXIT.OK)
    } finally {
      io.restore()
    }
    // The transcript prints with the step name as a prefix; both runs have
    // the same step name so the only proof we hit `latest` is no error.
    expect(io.stdout()).toContain('── done ──')
    expect(io.stderr()).toBe('')
  })

  it('exits 2 with "No runs found" when --latest finds nothing', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-logs-empty-')
    const deps = makeDeps()

    const io = capture()
    try {
      const code = await logsCmd(deps, '', {}, opts({ latest: true }))
      expect(code).toBe(EXIT.CONFIG_ERROR)
    } finally {
      io.restore()
    }
    expect(io.stderr()).toContain('No runs found')
  })

  it('rejects --latest combined with a positional runId as mutually exclusive', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-logs-mutex-')
    const deps = makeDeps()

    const io = capture()
    try {
      const code = await logsCmd(deps, 'r-2026-04-29-000003-bb', {}, opts({ latest: true }))
      expect(code).toBe(EXIT.CONFIG_ERROR)
    } finally {
      io.restore()
    }
    expect(io.stderr()).toContain('--latest is mutually exclusive')
  })
})

// ---------------------------------------------------------------------------
// --step (exact match)
// ---------------------------------------------------------------------------

describe('orch logs <runId> --step <name>', () => {
  it('prints only the named step when --step is an exact match', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-logs-step-match-')
    const deps = makeDeps()
    const rid = 'r-2026-04-29-000005-cc' as RunId

    // Each step writes a `system` event whose body contains the step name —
    // that body lands in stdout as a `line`-kind transcript line, so the
    // `[<step>]` prefix attaches and we can prove --step filtered correctly.
    const eventFor = (s: string): string =>
      `${JSON.stringify({ kind: 'system', type: `marker-${s}`, data: null })}\n`

    await deps.stateStore.initRun(rid, { workflowName: 'demo', startedAt: 1000 })
    for (const name of ['plan', 'code', 'review'] as const) {
      const transcriptPath = `logs/agents/${name}/events.ndjson`
      await deps.stateStore.saveStep(
        rid,
        makeStepEntry({
          name,
          startedAt: 1000 + name.length,
          endedAt: 2000,
          transcriptPath,
          transcriptEventCount: 1,
        }),
      )
      const dir = join(tmpDir, rid, 'logs', 'agents', name)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(join(dir, 'events.ndjson'), eventFor(name))
    }
    await deps.stateStore.setStatus(rid, 'completed', 5000)

    const io = capture()
    try {
      const code = await logsCmd(deps, rid, {}, opts({ step: 'code' }))
      expect(code).toBe(EXIT.OK)
    } finally {
      io.restore()
    }
    expect(io.stdout()).toContain('marker-code')
    expect(io.stdout()).not.toContain('marker-plan')
    expect(io.stdout()).not.toContain('marker-review')
  })

  it('exits 2 and lists valid step names when --step has no exact match', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-logs-step-miss-')
    const deps = makeDeps()
    const rid = 'r-2026-04-29-000007-dd' as RunId
    await seedRun(deps, rid, 'plan', 'completed')

    const io = capture()
    try {
      const code = await logsCmd(deps, rid, {}, opts({ step: 'PLAN' }))
      expect(code).toBe(EXIT.CONFIG_ERROR)
    } finally {
      io.restore()
    }
    expect(io.stderr()).toContain('No step matching "PLAN"')
    expect(io.stderr()).toContain('plan')
  })
})

// ---------------------------------------------------------------------------
// --follow
// ---------------------------------------------------------------------------

describe('orch logs <runId> --follow', () => {
  it('exits 2 with a hint pointing at --step when --follow is missing --step', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-logs-follow-no-step-')
    const deps = makeDeps()
    const rid = 'r-2026-04-29-000009-ee' as RunId
    await seedRun(deps, rid, 'plan', 'completed')

    const io = capture()
    try {
      const code = await logsCmd(deps, rid, {}, opts({ follow: true }))
      expect(code).toBe(EXIT.CONFIG_ERROR)
    } finally {
      io.restore()
    }
    expect(io.stderr()).toContain('--follow requires --step')
  })

  it('prints the full transcript and exits 0 without tailing when the run is already completed', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-logs-follow-completed-')
    const deps = makeDeps()
    const rid = 'r-2026-04-29-000011-ff' as RunId
    await seedRun(deps, rid, 'plan', 'completed')

    const io = capture()
    try {
      const code = await logsCmd(deps, rid, {}, opts({ follow: true, step: 'plan' }))
      expect(code).toBe(EXIT.OK)
    } finally {
      io.restore()
    }
    expect(io.stdout()).toContain('── done ──')
  })

  it('prints the full transcript and exits 0 without tailing when the run has crashed', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-logs-follow-crashed-')
    const deps = makeDeps()
    const rid = 'r-2026-04-29-000013-gg' as RunId
    await seedRun(deps, rid, 'plan', 'crashed')

    const io = capture()
    try {
      const code = await logsCmd(deps, rid, {}, opts({ follow: true, step: 'plan' }))
      expect(code).toBe(EXIT.OK)
    } finally {
      io.restore()
    }
    expect(io.stdout()).toContain('── done ──')
  })

  it('tails an in-progress run and exits 0 once the run reaches a terminal status', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-logs-follow-running-')
    const deps = makeDeps()
    const rid = 'r-2026-04-29-000015-hh' as RunId
    await seedRun(deps, rid, 'plan', 'running')

    // Flip the run to `completed` after a tick so the status-poll loop
    // sees a terminal status and aborts the tail.
    setTimeout(() => {
      void deps.stateStore.setStatus(rid, 'completed', 5000)
    }, 1200)

    const io = capture()
    try {
      const code = await logsCmd(deps, rid, {}, opts({ follow: true, step: 'plan' }))
      expect(code).toBe(EXIT.OK)
    } finally {
      io.restore()
    }
  }, 10_000)
})
