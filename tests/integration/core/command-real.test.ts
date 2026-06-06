// MIGRATED → tests-new/integration/core/command-real.test.ts (parent U10) — relocated verbatim (import paths only); kept skipped on disk (D2).
// command() — real BunProcessService integration. Auto-skips when `bun` is
// not on PATH (matches the pattern worktree's real-git tests use).

import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import { type CommandResult, command, tail } from '../../../src/core/command.ts'
import { StepError } from '../../../src/core/errors.ts'
import { type WorkflowDeps, workflow } from '../../../src/core/workflow.ts'
import {
  BunFsService,
  BunProcessService,
  FakeClock,
  FakeGitService,
  path,
} from '../../../src/services/index.ts'
import { FakePromptService } from '../../../src/services/prompt/index.ts'
import { FileStateStore, type RunId } from '../../../src/state/index.ts'
import { createFakeHost } from '../../helpers/fake-host.ts'

const BUN_BIN = (Bun as unknown as { which?: (s: string) => string | null }).which?.('bun') ?? null
const SHELL_BIN = (Bun as unknown as { which?: (s: string) => string | null }).which?.('sh') ?? null

const REPO_ROOT = path(process.cwd())

let tmpDir: string

afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

function makeRealDeps(): WorkflowDeps {
  const bunFs = new BunFsService()
  return {
    processService: new BunProcessService(),
    clock: new FakeClock(0),
    fsService: bunFs,
    gitService: new FakeGitService(),
    stateStore: new FileStateStore({ fs: bunFs, basePath: path(tmpDir) }),
    runId: 'r-2026-05-05-100000-rl' as RunId,
    cwd: REPO_ROOT,
    host: createFakeHost(),
    promptService: new FakePromptService(),
    interactivity: 'interactive' as const,
  }
}

/** Box to dodge TS's flow narrowing of closure-mutated `let` to `never`. */
interface Box<T> {
  value?: T
}

describe.skip('command() — real BunProcessService', () => {
  if (BUN_BIN === null) {
    it.skip('skipped: bun binary not found on PATH', () => {})
    return
  }
  if (SHELL_BIN === null) {
    it.skip('skipped: sh binary not found on PATH', () => {})
    return
  }

  it('runs `bun --version` and captures stdout', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-cmd-real-')
    const deps = makeRealDeps()

    const out: Box<CommandResult> = {}
    const wf = workflow('real-version', async (run) => {
      out.value = await run(
        command('bun-version', { argv: [BUN_BIN, '--version'], onFailure: 'halt' }),
      )
    })
    await wf.execute(deps)

    expect(out.value?.exitCode).toBe(0)
    expect((out.value?.stdout ?? '').trim().length).toBeGreaterThan(0)
  })

  it('captures stderr from a sh -c snippet that writes to both', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-cmd-real-')
    const deps = makeRealDeps()

    const out: Box<CommandResult> = {}
    const wf = workflow('real-streams', async (run) => {
      out.value = await run(
        command('mixed', {
          argv: [SHELL_BIN, '-c', 'printf "out\\n"; printf "err\\n" 1>&2'],
          onFailure: 'halt',
        }),
      )
    })
    await wf.execute(deps)

    expect(out.value?.stdout).toContain('out')
    expect(out.value?.stderr).toContain('err')
  })

  it("non-zero exit halts under onFailure:'halt'", async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-cmd-real-')
    const deps = makeRealDeps()

    const wf = workflow('real-halt', async (run) => {
      await run(command('fail', { argv: [SHELL_BIN, '-c', 'exit 7'], onFailure: 'halt' }))
    })

    let caught: unknown
    try {
      await wf.execute(deps)
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(StepError)
    expect((caught as StepError).exitCode).toBe(7)
  })

  it("non-zero exit returns the result under onFailure:'continue'", async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-cmd-real-')
    const deps = makeRealDeps()

    const out: Box<CommandResult> = {}
    const wf = workflow('real-cont', async (run) => {
      out.value = await run(
        command('soft', { argv: [SHELL_BIN, '-c', 'exit 3'], onFailure: 'continue' }),
      )
    })
    await wf.execute(deps)

    expect(out.value?.exitCode).toBe(3)
  })

  it('tail(result.stdout, 5) returns the last 5 lines of a 20-line program', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-cmd-real-')
    const deps = makeRealDeps()

    const out: Box<CommandResult> = {}
    const wf = workflow('real-tail', async (run) => {
      out.value = await run(
        command('count', {
          argv: [SHELL_BIN, '-c', 'for i in $(seq 1 20); do printf "line-%s\\n" "$i"; done'],
          onFailure: 'halt',
        }),
      )
    })
    await wf.execute(deps)

    const trimmed = tail(out.value?.stdout ?? '', 5)
    expect(trimmed).toBe('line-16\nline-17\nline-18\nline-19\nline-20\n')
  })

  it("the cwd override actually changes the spawn's working directory", async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-cmd-real-')
    const deps = makeRealDeps()

    const out: Box<CommandResult> = {}
    const wf = workflow('real-cwd', async (run) => {
      out.value = await run(
        command('pwd-here', {
          argv: [SHELL_BIN, '-c', 'pwd'],
          onFailure: 'halt',
          cwd: path(tmpDir),
        }),
      )
    })
    await wf.execute(deps)

    // pwd may print a /private prefix on macOS for /tmp, so allow `endsWith`.
    expect((out.value?.stdout ?? '').trim().endsWith(tmpDir)).toBe(true)
  })
})
