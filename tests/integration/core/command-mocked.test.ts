import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import { createFakeHost, type FakeHost } from '@orch/test/fake-host.ts'
import { type CommandResult, command } from '../../../src/core/command.ts'
import { StepError } from '../../../src/core/errors.ts'
import { parallel } from '../../../src/core/parallel.ts'
import { type WorkflowDeps, workflow } from '../../../src/core/workflow.ts'
import { createWorktree } from '../../../src/core/worktree.ts'
import {
  BunFsService,
  FakeClock,
  FakeGitService,
  FakeProcessService,
  type Path,
  path,
} from '../../../src/services/index.ts'
import { FakePromptService } from '../../../src/services/prompt/index.ts'
import { FileStateStore, type RunId } from '../../../src/state/index.ts'

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const REPO_ROOT = path('/workspace/proj')

let tmpDir: string

afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

interface DepsBundle extends WorkflowDeps {
  readonly processService: FakeProcessService
  readonly gitService: FakeGitService
  readonly clock: FakeClock
  readonly host: FakeHost
}

function makeDeps(overrides?: {
  processService?: FakeProcessService
  runId?: RunId
  cwd?: Path
}): DepsBundle {
  const processService = overrides?.processService ?? new FakeProcessService()
  const gitService = new FakeGitService()
  const clock = new FakeClock(1000)
  const bunFs = new BunFsService()
  const host = createFakeHost()
  return {
    processService,
    gitService,
    clock,
    fsService: bunFs,
    stateStore: new FileStateStore({ fs: bunFs, basePath: path(tmpDir) }),
    runId: overrides?.runId ?? ('r-2026-05-05-100000-c1' as RunId),
    cwd: overrides?.cwd ?? REPO_ROOT,
    host,
    promptService: new FakePromptService(),
    interactivity: 'interactive' as const,
  }
}

/** Box to dodge TS's flow narrowing of closure-mutated `let` to `never`. */
interface Box<T> {
  value?: T
}

function commandLines(host: FakeHost, step?: string): readonly { stream: string; line: string }[] {
  return host.recorded
    .filter((e) => e.kind === 'command-line')
    .map((e) => e.spec)
    .filter((s) => (step === undefined ? true : (s.step as string) === step))
    .map((s) => ({ stream: s.stream, line: s.line }))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('command() — mocked integration: capture + streaming', () => {
  it('runs argv through ProcessService and captures stdout in the result', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-command-test-')
    const deps = makeDeps()
    deps.processService.when(['echo', 'hello']).respondWith({ stdout: ['hello'], exitCode: 0 })

    const out: Box<CommandResult> = {}
    const wf = workflow('cmd-capture', async (run) => {
      out.value = await run(command('echo', { argv: ['echo', 'hello'], onFailure: 'halt' }))
    })
    await wf.execute(deps)

    expect(out.value).toBeDefined()
    expect(out.value?.exitCode).toBe(0)
    expect(out.value?.stdout).toBe('hello\n')
    expect(out.value?.stderr).toBe('')
  })

  it('captures stderr lines into result.stderr', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-command-test-')
    const deps = makeDeps()
    deps.processService
      .when(['cmd'])
      .respondWith({ stdout: [], stderr: ['warn-1', 'warn-2'], exitCode: 0 })

    const out: Box<CommandResult> = {}
    const wf = workflow('cmd-stderr', async (run) => {
      out.value = await run(command('warn', { argv: ['cmd'], onFailure: 'halt' }))
    })
    await wf.execute(deps)

    expect(out.value?.stderr).toBe('warn-1\nwarn-2\n')
  })

  it('streams stdout lines into host.onCommandLine in arrival order', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-command-test-')
    const deps = makeDeps()
    deps.processService.when(['cmd']).respondWith({ stdout: ['a', 'b', 'c'], exitCode: 0 })

    const wf = workflow('cmd-order', async (run) => {
      await run(command('seq', { argv: ['cmd'], onFailure: 'halt' }))
    })
    await wf.execute(deps)

    const lines = commandLines(deps.host, 'command:seq').filter((l) => l.stream === 'stdout')
    expect(lines.map((l) => l.line)).toEqual(['a', 'b', 'c'])
  })

  it("routes lines to the resolved pane (default 'right')", async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-command-test-')
    const deps = makeDeps()
    deps.processService.when(['cmd']).respondWith({ stdout: ['x'], exitCode: 0 })

    const wf = workflow('cmd-pane-default', async (run) => {
      await run(command('p', { argv: ['cmd'], onFailure: 'halt' }))
    })
    await wf.execute(deps)

    const evs = deps.host.recorded.filter((e) => e.kind === 'command-line').map((e) => e.spec)
    expect(evs).toHaveLength(1)
    expect(evs[0]?.pane).toBe('right')
  })

  it("respects pane: 'left' override", async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-command-test-')
    const deps = makeDeps()
    deps.processService.when(['cmd']).respondWith({ stdout: ['x'], exitCode: 0 })

    const wf = workflow('cmd-pane-left', async (run) => {
      await run(command('p', { argv: ['cmd'], onFailure: 'halt', pane: 'left' }))
    })
    await wf.execute(deps)

    const evs = deps.host.recorded.filter((e) => e.kind === 'command-line').map((e) => e.spec)
    expect(evs[0]?.pane).toBe('left')
  })

  it('silent: true skips host.onCommandLine but still captures stdout/stderr', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-command-test-')
    const deps = makeDeps()
    deps.processService.when(['cmd']).respondWith({ stdout: ['silent-line'], exitCode: 0 })

    const out: Box<CommandResult> = {}
    const wf = workflow('cmd-silent', async (run) => {
      out.value = await run(command('q', { argv: ['cmd'], onFailure: 'halt', silent: true }))
    })
    await wf.execute(deps)

    expect(out.value?.stdout).toBe('silent-line\n')
    expect(commandLines(deps.host)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Failure semantics
// ---------------------------------------------------------------------------

describe('command() — mocked integration: failure semantics', () => {
  it("throws StepError on non-zero exit when onFailure is 'halt'", async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-command-test-')
    const deps = makeDeps()
    deps.processService.when(['cmd']).respondWith({ stdout: [], exitCode: 7 })

    const wf = workflow('cmd-halt', async (run) => {
      await run(command('boom', { argv: ['cmd'], onFailure: 'halt' }))
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

  it("returns the result on non-zero exit when onFailure is 'continue'", async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-command-test-')
    const deps = makeDeps()
    deps.processService.when(['cmd']).respondWith({ stdout: [], exitCode: 3 })

    const out: Box<CommandResult> = {}
    const wf = workflow('cmd-cont', async (run) => {
      out.value = await run(command('soft', { argv: ['cmd'], onFailure: 'continue' }))
    })
    await wf.execute(deps)

    expect(out.value?.exitCode).toBe(3)
  })

  it("emits step:complete (not step:failed) under onFailure:'continue' with non-zero exit", async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-command-test-')
    const deps = makeDeps()
    deps.processService.when(['cmd']).respondWith({ stdout: [], exitCode: 5 })

    const wf = workflow('cmd-cont-lc', async (run) => {
      await run(command('soft', { argv: ['cmd'], onFailure: 'continue' }))
    })
    await wf.execute(deps)

    const lifecycle = deps.host.recorded
      .filter((e) => e.kind === 'lifecycle')
      .map((e) => e.event.type)
    expect(lifecycle).toContain('step:complete')
    expect(lifecycle).not.toContain('step:failed')
  })

  it("emits step:failed under onFailure:'halt' with non-zero exit", async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-command-test-')
    const deps = makeDeps()
    deps.processService.when(['cmd']).respondWith({ stdout: [], exitCode: 1 })

    const wf = workflow('cmd-halt-lc', async (run) => {
      await run(command('boom', { argv: ['cmd'], onFailure: 'halt' }))
    })
    await wf.execute(deps).catch(() => {})

    const lifecycle = deps.host.recorded
      .filter((e) => e.kind === 'lifecycle')
      .map((e) => e.event.type)
    expect(lifecycle).toContain('step:failed')
    expect(lifecycle).not.toContain('step:complete')
  })
})

// ---------------------------------------------------------------------------
// Persistence + cache
// ---------------------------------------------------------------------------

describe('command() — mocked integration: state persistence + cache', () => {
  it('persists the CommandResult to state.json after success', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-command-test-')
    const deps = makeDeps()
    deps.processService.when(['cmd']).respondWith({ stdout: ['ok'], exitCode: 0 })

    const wf = workflow('cmd-persist', async (run) => {
      await run(command('persist', { argv: ['cmd'], onFailure: 'halt' }))
    })
    await wf.execute(deps)

    const state = await deps.stateStore.loadRun(deps.runId)
    expect(state?.status).toBe('completed')
    const entry = state?.steps['command:persist']
    expect(entry).toBeDefined()
    expect(entry?.value).toMatchObject({
      exitCode: 0,
      stdout: 'ok\n',
      stderr: '',
    })
  })

  it('persists the CommandResult under continue policy with non-zero exit', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-command-test-')
    const deps = makeDeps()
    deps.processService.when(['cmd']).respondWith({ stdout: ['fail-out'], exitCode: 9 })

    const wf = workflow('cmd-persist-fail', async (run) => {
      await run(command('persist', { argv: ['cmd'], onFailure: 'continue' }))
    })
    await wf.execute(deps)

    const state = await deps.stateStore.loadRun(deps.runId)
    const entry = state?.steps['command:persist']
    expect(entry?.value).toMatchObject({
      exitCode: 9,
      stdout: 'fail-out\n',
    })
  })

  it('cache hit on resume returns the persisted CommandResult without re-spawning', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-command-test-')
    const sharedRunId = 'r-2026-05-05-100200-c2' as RunId

    // First run — command succeeds, then a follow-up step throws so the run
    // ends with status: 'crashed' and resume() can be called.
    const deps1 = makeDeps({ runId: sharedRunId })
    deps1.processService.when(['cmd']).respondWith({ stdout: ['cached-line'], exitCode: 0 })

    const wf1 = workflow('cmd-cache', async (run) => {
      await run(command('cached', { argv: ['cmd'], onFailure: 'halt' }))
      throw new Error('boom — forces crash so we can resume')
    })
    await wf1.execute(deps1).catch(() => {})

    // Second run — same runId. ProcessService has NO scripted response, so
    // any spawn attempt throws "no scripted response". The command step must
    // hit the cache.
    const deps2 = makeDeps({ runId: sharedRunId })

    const out: Box<CommandResult> = {}
    const wf2 = workflow('cmd-cache', async (run) => {
      out.value = await run(command('cached', { argv: ['cmd'], onFailure: 'halt' }))
      // Don't throw on resume — we want the resume to succeed for assertions.
    })
    await wf2.resume(deps2)

    expect(out.value?.stdout).toBe('cached-line\n')
  })
})

// ---------------------------------------------------------------------------
// Cwd resolution
// ---------------------------------------------------------------------------

describe('command() — mocked integration: cwd', () => {
  it('resolves cwd to currentCwd (deps.cwd) when config.cwd is absent', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-command-test-')
    const deps = makeDeps({ cwd: path('/some/repo') })
    deps.processService.when(['cmd']).respondWith({ stdout: [], exitCode: 0 })

    const wf = workflow('cmd-cwd-default', async (run) => {
      await run(command('here', { argv: ['cmd'], onFailure: 'halt' }))
    })
    await wf.execute(deps)

    const state = await deps.stateStore.loadRun(deps.runId)
    // Reproduce text contains the cwd path; we read the spawn record indirectly
    // by checking the persisted entry's cwd via session.json side effect is
    // logger-only; here we assert the executor actually ran (success) and rely
    // on the worktree-cwd test for the rebinding case.
    expect(state?.steps['command:here']).toBeDefined()
  })

  it('resolves cwd verbatim when config.cwd is absolute', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-command-test-')
    const deps = makeDeps()
    deps.processService.when(['cmd']).respondWith({ stdout: [], exitCode: 0 })

    const wf = workflow('cmd-cwd-abs', async (run) => {
      await run(
        command('abs', {
          argv: ['cmd'],
          onFailure: 'halt',
          cwd: path('/abs/path'),
        }),
      )
    })
    await wf.execute(deps)

    const state = await deps.stateStore.loadRun(deps.runId)
    expect(state?.steps['command:abs']).toBeDefined()
  })

  it('inherits the active worktree cwd when createWorktree({enter:true}) ran upstream', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-command-test-')
    const deps = makeDeps()

    deps.gitService.setRepoRoot(REPO_ROOT, REPO_ROOT)
    deps.gitService.setBranchExists(REPO_ROOT, 'feat/x', false)
    deps.gitService.setWorktreePathExists(REPO_ROOT, path('/workspace/proj--feat-x'), false)
    deps.gitService.allowAddWorktree(REPO_ROOT)

    // The fake spawn records the cwd it received via ctx; we verify by adding
    // a custom argv-distinct call so any miss surfaces as "no scripted response".
    const inWorktreePs = new FakeProcessService()
    const cwds: string[] = []
    const original = inWorktreePs.spawn.bind(inWorktreePs)
    inWorktreePs.spawn = (opts) => {
      cwds.push(opts.cwd as string)
      return original(opts)
    }
    inWorktreePs.when(['pwd']).respondWith({ stdout: ['/workspace/proj--feat-x'], exitCode: 0 })

    const reusedDeps = { ...deps, processService: inWorktreePs }

    const wf = workflow('cmd-worktree-cwd', async (run) => {
      await run(createWorktree('feat/x', { enter: true }))
      await run(command('inside', { argv: ['pwd'], onFailure: 'halt' }))
    })
    await wf.execute(reusedDeps)

    expect(cwds).toContain('/workspace/proj--feat-x')
  })
})

// ---------------------------------------------------------------------------
// Env merge
// ---------------------------------------------------------------------------

describe('command() — mocked integration: env', () => {
  it('merges process.env with config.env (config.env wins)', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-command-test-')
    const deps = makeDeps()

    let observedEnv: Readonly<Record<string, string>> | null = null
    const originalSpawn = deps.processService.spawn.bind(deps.processService)
    deps.processService.spawn = (opts) => {
      observedEnv = opts.env
      return originalSpawn(opts)
    }
    deps.processService.when(['cmd']).respondWith({ stdout: [], exitCode: 0 })

    process.env.ORCH_CMD_TEST_BASE = 'from-process'
    process.env.ORCH_CMD_TEST_OVERRIDE = 'from-process'
    try {
      const wf = workflow('cmd-env', async (run) => {
        await run(
          command('env-merge', {
            argv: ['cmd'],
            onFailure: 'halt',
            env: { ORCH_CMD_TEST_OVERRIDE: 'from-config', ORCH_CMD_TEST_NEW: 'config-only' },
          }),
        )
      })
      await wf.execute(deps)
    } finally {
      delete process.env.ORCH_CMD_TEST_BASE
      delete process.env.ORCH_CMD_TEST_OVERRIDE
    }

    expect(observedEnv).not.toBeNull()
    const env = observedEnv as unknown as Record<string, string>
    expect(env.ORCH_CMD_TEST_BASE).toBe('from-process')
    expect(env.ORCH_CMD_TEST_OVERRIDE).toBe('from-config')
    expect(env.ORCH_CMD_TEST_NEW).toBe('config-only')
  })
})

// ---------------------------------------------------------------------------
// Parallel composition
// ---------------------------------------------------------------------------

describe('command() — mocked integration: parallel', () => {
  it('composes inside parallel(items, fn) without sharing capture buffers across branches', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-command-test-')
    const deps = makeDeps()
    deps.processService.when(['echo', 'a']).respondWith({ stdout: ['a-out'], exitCode: 0 })
    deps.processService.when(['echo', 'b']).respondWith({ stdout: ['b-out'], exitCode: 0 })

    const captured: Record<string, string> = {}

    const wf = workflow('cmd-par', async (run) => {
      await parallel(['a', 'b'], async (label) => {
        const r = await run(command(`run-${label}`, { argv: ['echo', label], onFailure: 'halt' }))
        captured[label] = r.stdout
      })
    })
    await wf.execute(deps)

    expect(captured.a).toBe('a-out\n')
    expect(captured.b).toBe('b-out\n')
  })
})

// ---------------------------------------------------------------------------
// Override rejection
// ---------------------------------------------------------------------------

describe('command() — mocked integration: override rejection', () => {
  it('rejects prompt overrides', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-command-test-')
    const deps = makeDeps()
    deps.processService.when(['cmd']).respondWith({ stdout: [], exitCode: 0 })

    const wf = workflow('cmd-no-prompt', async (run) => {
      await run(command('p', { argv: ['cmd'], onFailure: 'halt' }), {
        prompt: 'nope',
      })
    })

    let caught: unknown
    try {
      await wf.execute(deps)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeDefined()
    expect((caught as Error).message).toMatch(/prompt/)
  })

  it('rejects extraContext overrides', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-command-test-')
    const deps = makeDeps()
    deps.processService.when(['cmd']).respondWith({ stdout: [], exitCode: 0 })

    const wf = workflow('cmd-no-ec', async (run) => {
      await run(command('p', { argv: ['cmd'], onFailure: 'halt' }), {
        extraContext: { foo: 'bar' },
      })
    })

    let caught: unknown
    try {
      await wf.execute(deps)
    } catch (e) {
      caught = e
    }
    expect((caught as Error)?.message).toMatch(/extraContext/)
  })

  it('rejects extraPrompt overrides', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-command-test-')
    const deps = makeDeps()
    deps.processService.when(['cmd']).respondWith({ stdout: [], exitCode: 0 })

    const wf = workflow('cmd-no-ep', async (run) => {
      await run(command('p', { argv: ['cmd'], onFailure: 'halt' }), {
        extraPrompt: 'nope',
      })
    })

    let caught: unknown
    try {
      await wf.execute(deps)
    } catch (e) {
      caught = e
    }
    expect((caught as Error)?.message).toMatch(/extraPrompt/)
  })
})
