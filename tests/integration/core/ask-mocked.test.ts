import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import { createFakeHost } from '@orch/test/fake-host.ts'
import { ask } from '../../../src/core/ask.ts'
import { AskNoDefaultError, AskParallelError } from '../../../src/core/errors.ts'
import { parallel } from '../../../src/core/parallel.ts'
import { type WorkflowDeps, workflow } from '../../../src/core/workflow.ts'
import {
  BunFsService,
  FakeClock,
  FakeGitService,
  FakeProcessService,
  path,
} from '../../../src/services/index.ts'
import { FakePromptService } from '../../../src/services/prompt/index.ts'
import { FileStateStore, type RunId } from '../../../src/state/index.ts'

let tmpDir: string

afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

interface DepsOverrides {
  readonly runId?: RunId
  readonly promptService?: FakePromptService
  readonly interactivity?: 'interactive' | 'noninteractive'
}

function makeDeps(overrides: DepsOverrides = {}): WorkflowDeps & {
  promptService: FakePromptService
  clock: FakeClock
} {
  const bunFs = new BunFsService()
  return {
    processService: new FakeProcessService(),
    fsService: bunFs,
    gitService: new FakeGitService(),
    clock: new FakeClock(1000),
    stateStore: new FileStateStore({ fs: bunFs, basePath: path(tmpDir) }),
    runId: overrides.runId ?? ('r-2026-05-01-100000-a1' as RunId),
    cwd: path('/workspace'),
    host: createFakeHost(),
    promptService: overrides.promptService ?? new FakePromptService(),
    interactivity: overrides.interactivity ?? 'interactive',
  }
}

describe('ask step — mocked integration', () => {
  it('runs the prompt service and persists the typed value', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-ask-test-')
    const prompts = new FakePromptService()
    prompts.when('ask:continue').respondWith({
      cancelled: false,
      button: 'continue',
      fields: { notes: 'all good' },
    })
    const deps = makeDeps({ promptService: prompts })

    const ASK_CONTINUE = ask({
      name: 'continue',
      question: 'continue?',
      fields: { notes: { placeholder: 'optional' } },
      buttons: ['continue', 'retry'],
    })

    let result: unknown
    const wf = workflow('ask-test', async (run) => {
      result = await run(ASK_CONTINUE)
    })
    await wf.execute(deps)

    expect(result).toEqual({
      cancelled: false,
      button: 'continue',
      fields: { notes: 'all good' },
    })

    const state = await deps.stateStore.loadRun(deps.runId)
    expect(state?.steps['ask:continue']?.value).toEqual({
      cancelled: false,
      button: 'continue',
      fields: { notes: 'all good' },
    })
    expect(state?.steps['ask:continue']?.mode).toBe('interactive')
    expect(prompts.recorded()).toHaveLength(1)
  })

  it('replays the cached ask on resume without calling the prompt service', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-ask-test-')
    const runId = 'r-2026-05-01-100100-a2' as RunId

    const prompts1 = new FakePromptService()
    prompts1.when('ask:c').respondWith({ cancelled: false, button: 'ok', fields: {} })
    const deps1 = makeDeps({ runId, promptService: prompts1 })

    const ASK = ask({ name: 'c', question: 'q?', buttons: ['ok'] })

    const wf1 = workflow('ask-resume', async (run) => {
      await run(ASK)
    })
    await wf1.execute(deps1)

    expect(prompts1.recorded()).toHaveLength(1)

    // Run again with the same runId; cached ask replays without re-prompting.
    const prompts2 = new FakePromptService() // no .when()
    const deps2 = makeDeps({ runId, promptService: prompts2 })

    const wf2 = workflow('ask-resume', async (run) => {
      await run(ASK)
    })
    await wf2.execute(deps2)

    expect(prompts2.recorded()).toHaveLength(0)
    const state = await deps2.stateStore.loadRun(runId)
    expect(state?.status).toBe('completed')
  })

  it('caches a cancelled ask and replays it without re-prompting', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-ask-test-')
    const runId = 'r-2026-05-01-100200-a3' as RunId

    const prompts1 = new FakePromptService()
    prompts1.when('ask:c').respondWith({
      cancelled: true,
      fields: { notes: 'partial' },
    })
    const deps1 = makeDeps({ runId, promptService: prompts1 })

    const ASK = ask({
      name: 'c',
      question: 'q?',
      fields: { notes: { placeholder: 'p' } },
      buttons: ['ok'],
    })

    const wf1 = workflow('cancel-cache', async (run) => {
      const r = await run(ASK)
      // The workflow author decides what cancel means; we test the cached
      // value is recoverable on resume. Throw here to force a "crashed" state.
      if (r.cancelled) throw new Error('cancelled-by-user')
    })

    try {
      await wf1.execute(deps1)
    } catch {
      // expected
    }

    const prompts2 = new FakePromptService()
    const deps2 = makeDeps({ runId, promptService: prompts2 })

    let replayed: unknown
    const wf2 = workflow('cancel-cache', async (run) => {
      replayed = await run(ASK)
    })
    await wf2.resume(deps2)

    expect(prompts2.recorded()).toHaveLength(0)
    expect(replayed).toEqual({ cancelled: true, fields: { notes: 'partial' } })
  })

  it('re-prompts when the cached entry has a button no longer in the config', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-ask-test-')
    const runId = 'r-2026-05-01-100300-a4' as RunId

    const prompts1 = new FakePromptService()
    prompts1.when('ask:c').respondWith({ cancelled: false, button: 'old-button', fields: {} })
    const deps1 = makeDeps({ runId, promptService: prompts1 })

    const OLD = ask({ name: 'c', question: 'q?', buttons: ['old-button'] })
    const wf1 = workflow('cache-stale', async (run) => {
      await run(OLD)
    })
    await wf1.execute(deps1)

    // Resume with a config that removed `old-button`. Cache must invalidate
    // and the new prompt service must be called.
    const prompts2 = new FakePromptService()
    prompts2.when('ask:c').respondWith({ cancelled: false, button: 'new-button', fields: {} })
    const deps2 = makeDeps({ runId, promptService: prompts2 })

    const NEW = ask({ name: 'c', question: 'q?', buttons: ['new-button'] })
    const wf2 = workflow('cache-stale', async (run) => {
      await run(NEW)
    })
    // Run again with the same runId — the existing state has the stale entry.
    // initRun is a no-op when state exists, so execute() falls into the
    // cache-validity preflight and re-prompts with the new spec.
    await wf2.execute(deps2)

    expect(prompts2.recorded()).toHaveLength(1)
    const state = await deps2.stateStore.loadRun(runId)
    expect(state?.steps['ask:c']?.value).toEqual({
      cancelled: false,
      button: 'new-button',
      fields: {},
    })
  })

  it('re-prompts when the cached entry is missing a current field key', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-ask-test-')
    const runId = 'r-2026-05-01-100400-a5' as RunId

    const prompts1 = new FakePromptService()
    prompts1.when('ask:c').respondWith({
      cancelled: false,
      button: 'ok',
      fields: { notes: 'old' },
    })
    const deps1 = makeDeps({ runId, promptService: prompts1 })

    const OLD = ask({
      name: 'c',
      question: 'q?',
      fields: { notes: { placeholder: 'p' } },
      buttons: ['ok'],
    })
    await workflow('rename-field', async (run) => {
      await run(OLD)
    }).execute(deps1)

    const prompts2 = new FakePromptService()
    prompts2.when('ask:c').respondWith({
      cancelled: false,
      button: 'ok',
      fields: { comment: 'new' },
    })
    const deps2 = makeDeps({ runId, promptService: prompts2 })

    const RENAMED = ask({
      name: 'c',
      question: 'q?',
      fields: { comment: { placeholder: 'p' } },
      buttons: ['ok'],
    })
    await workflow('rename-field', async (run) => {
      await run(RENAMED)
    }).execute(deps2)

    expect(prompts2.recorded()).toHaveLength(1)
  })

  it('keeps cancelled cache valid across button changes', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-ask-test-')
    const runId = 'r-2026-05-01-100500-a6' as RunId

    const prompts1 = new FakePromptService()
    prompts1.when('ask:c').respondWith({ cancelled: true, fields: {} })
    const deps1 = makeDeps({ runId, promptService: prompts1 })

    const OLD = ask({ name: 'c', question: 'q?', buttons: ['old'] })
    const wf1 = workflow('cancel-shape-immune', async (run) => {
      const r = await run(OLD)
      if (r.cancelled) throw new Error('cancelled')
    })
    try {
      await wf1.execute(deps1)
    } catch {
      // expected
    }

    const prompts2 = new FakePromptService()
    const deps2 = makeDeps({ runId, promptService: prompts2 })

    const NEW = ask({ name: 'c', question: 'q?', buttons: ['shiny-new'] })
    const wf2 = workflow('cancel-shape-immune', async (run) => {
      await run(NEW)
    })
    await wf2.resume(deps2)

    expect(prompts2.recorded()).toHaveLength(0)
  })

  it('resolves declared default under noninteractive without calling the prompt service', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-ask-test-')
    const prompts = new FakePromptService()
    const deps = makeDeps({ promptService: prompts, interactivity: 'noninteractive' })

    const ASK = ask({
      name: 'c',
      question: 'q?',
      fields: { notes: { placeholder: 'p' } },
      buttons: ['continue'],
      defaultWhenNoninteractive: { button: 'continue' },
    })

    let result: unknown
    await workflow('noninteractive-default', async (run) => {
      result = await run(ASK)
    }).execute(deps)

    expect(result).toEqual({ cancelled: false, button: 'continue', fields: { notes: '' } })
    expect(prompts.recorded()).toHaveLength(0)
  })

  it('throws AskNoDefaultError under noninteractive when no default is declared', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-ask-test-')
    const deps = makeDeps({ interactivity: 'noninteractive' })

    const ASK = ask({
      name: 'c',
      question: 'q?',
      fields: { notes: { placeholder: 'p' } },
      buttons: ['continue', 'retry'],
    })

    let caught: unknown
    try {
      await workflow('no-default', async (run) => {
        await run(ASK)
      }).execute(deps)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(AskNoDefaultError)
    if (caught instanceof AskNoDefaultError) {
      expect(caught.message).toContain('ask:c')
      expect(caught.message).toContain("'continue'")
      expect(caught.message).toContain("'retry'")
      expect(caught.message).toContain("notes: ''")
    }
  })

  it('throws AskParallelError when ask is invoked inside parallel()', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-ask-test-')
    const prompts = new FakePromptService()
    const deps = makeDeps({ promptService: prompts })

    const ASK_A = ask({ name: 'a', question: 'q?', buttons: ['ok'] })
    const ASK_B = ask({ name: 'b', question: 'q?', buttons: ['ok'] })

    let caught: unknown
    try {
      await workflow('parallel-ask', async (run) => {
        await parallel(['a', 'b'], async (which) => {
          await run(which === 'a' ? ASK_A : ASK_B)
        })
      }).execute(deps)
    } catch (err) {
      caught = err
    }

    // ParallelError wraps the AskParallelError instances per branch — fish
    // them out and assert on the underlying message.
    const errors = (caught as { settled?: ReadonlyArray<{ status: string; error?: unknown }> })
      ?.settled
    expect(errors).toBeDefined()
    const askParallels = (errors ?? [])
      .filter((s): s is { status: 'error'; error: unknown } => s.status === 'error')
      .map((s) => s.error)
    expect(askParallels.length).toBeGreaterThanOrEqual(1)
    for (const e of askParallels) {
      expect(e).toBeInstanceOf(AskParallelError)
      const msg = e instanceof Error ? e.message : String(e)
      expect(msg).toContain('Hoist the ask above')
      expect(msg).not.toContain('--noninteractive')
    }
    expect(prompts.recorded()).toHaveLength(0)
  })

  it('crashes resume into noninteractive when the un-cached ask has no default', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-ask-test-')
    const runId = 'r-2026-05-01-100700-a8' as RunId

    // First run: interactive, kill before ask is reached.
    const prompts1 = new FakePromptService()
    const deps1 = makeDeps({ runId, promptService: prompts1 })

    const ASK = ask({ name: 'c', question: 'q?', buttons: ['continue', 'retry'] })

    const wf1 = workflow('resume-noninteractive', async (_run) => {
      // Don't reach ask — throw before so the run crashes with no ask cached.
      throw new Error('crashed-before-ask')
    })
    try {
      await wf1.execute(deps1)
    } catch {
      // expected
    }

    // Resume under noninteractive without a declared default.
    const deps2 = makeDeps({ runId, interactivity: 'noninteractive' })
    const wf2 = workflow('resume-noninteractive', async (run) => {
      await run(ASK)
    })

    let caught: unknown
    try {
      await wf2.resume(deps2)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(AskNoDefaultError)
    if (caught instanceof AskNoDefaultError) {
      expect(caught.message).toContain('ask:c')
    }
  })

  it('rejects prompt overrides on an ask step at the call site', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-ask-test-')
    const prompts = new FakePromptService()
    prompts.when('ask:c').respondWith({ cancelled: false, button: 'ok', fields: {} })
    const deps = makeDeps({ promptService: prompts })

    const ASK = ask({ name: 'c', question: 'q?', buttons: ['ok'] })

    let caught: unknown
    try {
      await workflow('override-reject', async (run) => {
        await run(ASK, { prompt: 'override' })
      }).execute(deps)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain('does not accept prompt overrides')
  })
})
