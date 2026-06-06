// Behavioural tests for the lifecycle visibility of `ask()` steps.
//
// User-observable invariant: while an `ask()` prompt is waiting for input,
// the surrounding TUI must be able to *navigate to* that prompt — i.e. it
// must know the prompt step exists. The only signal hosts get for "this
// step started" is the `step:start` StepLifecycleEvent, which the executor
// emits for `agent` and `command` steps via `emitStepLifecycle`. If `ask`
// silently skips this emit, the two-pane host's steps-view projection has
// no row for the prompt step — the user can navigate to other rows, swap
// the prompt off-screen, and have no way to navigate back.
//
// These tests pin the contract from the **outside**: a host that captures
// lifecycle events sees `step:start` before the prompt resolves, and
// `step:complete` after, exactly like the `command` step kind.

import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import { createFakeHost } from '@orch/test/fake-host.ts'
import { ask } from '../../../src/core/ask.ts'
import type { StepLifecycleEvent } from '../../../src/core/workflow.ts'
import { type WorkflowDeps, workflow } from '../../../src/core/workflow.ts'
import {
  BunFsService,
  FakeClock,
  FakeGitService,
  FakeProcessService,
  path,
} from '../../../src/services/index.ts'
import type { PromptCtx, PromptResult, PromptSpec } from '../../../src/services/prompt/index.ts'
import { FakePromptService } from '../../../src/services/prompt/index.ts'
import { FileStateStore, type RunId } from '../../../src/state/index.ts'

let tmpDir: string

afterEach(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

interface DepsOverrides {
  readonly promptService?: ConstructorParameters<typeof Object>[number] extends never
    ? never
    : import('../../../src/services/prompt/index.ts').PromptService
}

function makeDeps(overrides: DepsOverrides = {}): WorkflowDeps {
  const bunFs = new BunFsService()
  return {
    processService: new FakeProcessService(),
    fsService: bunFs,
    gitService: new FakeGitService(),
    clock: new FakeClock(1000),
    stateStore: new FileStateStore({ fs: bunFs, basePath: path(tmpDir) }),
    runId: 'r-2026-05-22-212450-a1' as RunId,
    cwd: path('/workspace'),
    host: createFakeHost(),
    promptService: overrides.promptService ?? new FakePromptService(),
    interactivity: 'interactive',
  }
}

describe('ask step — lifecycle visibility (pins the disappearing-prompt bug)', () => {
  it('emits a step:start event for the ask step before the prompt is awaited so the TUI can show a row for it', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-ask-lifecycle-')

    // Custom prompt service that, *while the prompt is in flight*, observes
    // which lifecycle events the host has already received. This is the
    // behavioural moment that matters: a two-pane TUI's steps-view projection
    // is built from these events, so the prompt step must already be
    // announced by the time we hand control to the prompt UI.
    let seenWhilePromptOpen: readonly StepLifecycleEvent[] = []
    const deps = makeDeps()
    const host = deps.host as ReturnType<typeof createFakeHost>
    const stepName = 'ask:continue'

    const watchingPromptService = {
      async ask(_spec: PromptSpec, _ctx: PromptCtx): Promise<PromptResult> {
        seenWhilePromptOpen = host.recorded
          .filter((e) => e.kind === 'lifecycle')
          .map((e) => (e as { event: StepLifecycleEvent }).event)
        return { cancelled: false, button: 'continue', fields: { notes: '' } }
      },
    }

    const ASK_CONTINUE = ask({
      name: 'continue',
      question: 'continue?',
      fields: { notes: { placeholder: 'optional' } },
      buttons: ['continue', 'retry'],
    })

    const depsWithWatching: WorkflowDeps = { ...deps, promptService: watchingPromptService }

    await workflow('ask-lifecycle', async (run) => {
      await run(ASK_CONTINUE)
    }).execute(depsWithWatching)

    const startEvents = seenWhilePromptOpen.filter((e) => e.type === 'step:start')
    expect(startEvents).toHaveLength(1)
    expect(startEvents[0]).toMatchObject({ type: 'step:start', stepName })
  })

  it('emits a step:complete event for the ask step after the prompt resolves so the TUI can mark the row done', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-ask-lifecycle-')

    const prompts = new FakePromptService()
    prompts.when('ask:done').respondWith({
      cancelled: false,
      button: 'ok',
      fields: {},
    })
    const deps = makeDeps({ promptService: prompts })
    const host = deps.host as ReturnType<typeof createFakeHost>

    const ASK = ask({ name: 'done', question: 'done?', buttons: ['ok'] })

    await workflow('ask-lifecycle', async (run) => {
      await run(ASK)
    }).execute(deps)

    const lifecycleEvents = host.recorded
      .filter((e) => e.kind === 'lifecycle')
      .map((e) => (e as { event: StepLifecycleEvent }).event)

    const startsForAsk = lifecycleEvents.filter(
      (e) => e.type === 'step:start' && e.stepName === 'ask:done',
    )
    const completesForAsk = lifecycleEvents.filter(
      (e) => e.type === 'step:complete' && e.stepName === 'ask:done',
    )

    expect(startsForAsk).toHaveLength(1)
    expect(completesForAsk).toHaveLength(1)
  })
})
