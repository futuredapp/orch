// Shared harness + cmux-argv scripting helpers for the Phase 1 acceptance
// tests (AT-1 through AT-12). Lives co-located with the test file so the
// exact-argv contract stays one import away from the assertions, and so the
// test file stays under the project's file-size limit.

import { executeWithAttach } from '../../../../src/cli/commands/execute-with-attach.ts'
import { EXIT } from '../../../../src/cli/main.ts'
import { StepError } from '../../../../src/core/index.ts'
import { step } from '../../../../src/core/step.ts'
import { type WorkflowDeps, workflow } from '../../../../src/core/workflow.ts'
import {
  createCmuxHost,
  createCompositeHost,
  createPlainHost,
} from '../../../../src/hosts/index.ts'
import { FakeRunner } from '../../../../src/runners/index.ts'
import {
  FakeClock,
  FakeFsService,
  FakeGitService,
  type FakeProcessService,
  path,
} from '../../../../src/services/index.ts'
import { FakePromptService } from '../../../../src/services/prompt/index.ts'
import { FileStateStore, type RunId } from '../../../../src/state/index.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const RUN_ID = 'r-2026-06-07-000001-cm' as RunId
export const SURFACE = 'workspace1'
const SESSION_ID = '00000000-0000-0000-0000-000000000000'
// FakeRunner reports its name as 'fake'; the runner pill mirrors it.
export const RUNNER = 'fake'

export interface StepSpec {
  readonly name: string
  readonly mode: 'autonomous' | 'interactive'
  readonly fail?: boolean
}

// ---------------------------------------------------------------------------
// Output buffer (executeWithAttach + PlainHost write to streams)
// ---------------------------------------------------------------------------

export function bufferStream(): { stream: NodeJS.WritableStream; text: () => string } {
  const chunks: string[] = []
  const stream = {
    write(chunk: unknown): boolean {
      chunks.push(typeof chunk === 'string' ? chunk : String(chunk))
      return true
    },
  } as unknown as NodeJS.WritableStream
  return { stream, text: () => chunks.join('') }
}

// ---------------------------------------------------------------------------
// cmux argv scripting helpers
// ---------------------------------------------------------------------------

export function scriptPing(fps: FakeProcessService, exitCode: number): void {
  fps.when(['cmux', 'ping']).respondWith({ exitCode })
}

export function scriptStepPills(
  fps: FakeProcessService,
  opts: {
    readonly wf: string
    readonly step: string
    readonly index: number
    readonly runner: string
    readonly mode: 'autonomous' | 'interactive'
    readonly exitCode?: number
  },
): void {
  const modeLabel = opts.mode === 'autonomous' ? 'auto' : 'interactive'
  const exitCode = opts.exitCode ?? 0
  fps.when(['cmux', 'set-status', 'orch_workflow', opts.wf]).respondWith({ exitCode })
  fps
    .when(['cmux', 'set-status', 'orch_step', `${opts.step} · ${opts.index}`])
    .respondWith({ exitCode })
  fps.when(['cmux', 'set-status', 'orch_runner', opts.runner]).respondWith({ exitCode })
  fps.when(['cmux', 'set-status', 'orch_mode', modeLabel]).respondWith({ exitCode })
}

export function scriptInteractiveNotify(
  fps: FakeProcessService,
  opts: { readonly wf: string; readonly step: string },
): void {
  fps
    .when([
      'cmux',
      'notify',
      '--title',
      `orch · ${opts.wf}`,
      '--body',
      `⏸ step '${opts.step}' needs you`,
    ])
    .respondWith({ exitCode: 0 })
}

function scriptClearStatus(fps: FakeProcessService): void {
  for (const key of ['orch_workflow', 'orch_step', 'orch_runner', 'orch_mode']) {
    fps.when(['cmux', 'clear-status', key]).respondWith({ exitCode: 0 })
  }
}

export function scriptRunEndOk(
  fps: FakeProcessService,
  opts: { readonly wf: string; readonly duration?: string },
): void {
  fps
    .when([
      'cmux',
      'notify',
      '--title',
      `orch · ${opts.wf}`,
      '--body',
      `✅ completed in ${opts.duration ?? '0m0s'}`,
    ])
    .respondWith({ exitCode: 0 })
  scriptClearStatus(fps)
}

export function scriptRunEndFail(
  fps: FakeProcessService,
  opts: { readonly wf: string; readonly failedStep?: string },
): void {
  const body =
    opts.failedStep !== undefined ? `❌ failed at step '${opts.failedStep}'` : '❌ run failed'
  fps.when(['cmux', 'notify', '--title', `orch · ${opts.wf}`, '--body', body]).respondWith({
    exitCode: 0,
  })
  scriptClearStatus(fps)
}

// ---------------------------------------------------------------------------
// Call-history selectors
// ---------------------------------------------------------------------------

type Call = { readonly argv: readonly string[] }

export function setStatusCalls(fps: FakeProcessService): ReadonlyArray<Call> {
  return fps.cmuxCalls().filter((c) => c.argv[1] === 'set-status')
}

export function notifyCalls(fps: FakeProcessService): ReadonlyArray<Call> {
  return fps.cmuxCalls().filter((c) => c.argv[1] === 'notify')
}

export function clearStatusCalls(fps: FakeProcessService): ReadonlyArray<Call> {
  return fps.cmuxCalls().filter((c) => c.argv[1] === 'clear-status')
}

// ---------------------------------------------------------------------------
// Composition — build the live wiring the way runCmd does.
// ---------------------------------------------------------------------------

export interface Harness {
  readonly host: ReturnType<typeof createCompositeHost>
  readonly cmuxHost: Awaited<ReturnType<typeof createCmuxHost>>
  readonly deps: WorkflowDeps
  readonly agent: FakeRunner
  readonly fps: FakeProcessService
}

export async function buildHarness(opts: {
  readonly wf: string
  readonly fps: FakeProcessService
  readonly steps: readonly StepSpec[]
  readonly surfaceId?: string
  readonly cmuxEnabled?: boolean
}): Promise<Harness> {
  const fps = opts.fps
  const clock = new FakeClock(0)
  const fs = new FakeFsService()

  const primary = createPlainHost({
    stdout: bufferStream().stream,
    stderr: bufferStream().stream,
    format: 'text',
    clock,
    runId: RUN_ID,
  })

  const cmuxHost = await createCmuxHost({
    processService: fps,
    clock: new FakeClock(0),
    workflowName: opts.wf,
    cmuxConfig: opts.cmuxEnabled === undefined ? undefined : { enabled: opts.cmuxEnabled },
    env: opts.surfaceId === undefined ? {} : { CMUX_SURFACE_ID: opts.surfaceId },
    cwd: path('/workspace'),
  })

  const host = createCompositeHost(primary, cmuxHost)

  const agent = new FakeRunner(fps)
  // Autonomous steps consume one FakeRunner script each, in workflow order.
  // Interactive steps run through `onInteractive` and consume no script.
  for (const s of opts.steps) {
    if (s.mode === 'autonomous') {
      if (s.fail === true) {
        agent.script({ failWith: { message: `${s.name} failed` } })
      } else {
        agent.script({ structuredOutput: `${s.name}-done` })
      }
    }
  }

  const deps: WorkflowDeps = {
    fsService: fs,
    gitService: new FakeGitService(),
    processService: fps,
    clock,
    stateStore: new FileStateStore({ fs, basePath: path('/runs') }),
    runId: RUN_ID,
    cwd: path('/workspace'),
    host,
    promptService: new FakePromptService(),
    interactivity: 'interactive' as const,
    generateSessionId: () => SESSION_ID,
    onInteractive: async () => ({ exitCode: 0, durationMs: 0, sessionId: SESSION_ID }),
  }

  return { host, cmuxHost, deps, agent, fps }
}

function buildWorkflow(
  wf: string,
  steps: readonly StepSpec[],
  agent: FakeRunner,
): ReturnType<typeof workflow> {
  return workflow(wf, async (run) => {
    for (const s of steps) {
      if (s.mode === 'interactive') {
        await run(step.define(s.name, { agent, mode: 'interactive' }))
      } else {
        await run(step.define(s.name, { agent }))
      }
    }
  })
}

// Drive the workflow + composite host, then flush in-flight cmux spawns so the
// async pill chain has settled before assertions. Returns the run outcome.
export async function runBare(
  h: Harness,
  wf: string,
  steps: readonly StepSpec[],
): Promise<{ threw: boolean }> {
  let threw = false
  try {
    await buildWorkflow(wf, steps, h.agent).execute(h.deps)
  } catch {
    threw = true
  }
  await h.cmuxHost.flush()
  return { threw }
}

// Drive through executeWithAttach so the run-end `beforeTeardown → notifyRunEnd`
// hook fires, exactly as runCmd wires it.
export async function runViaAttach(
  h: Harness,
  wf: string,
  steps: readonly StepSpec[],
): Promise<number> {
  return executeWithAttach({
    host: h.host,
    workflow: buildWorkflow(wf, steps, h.agent).execute(h.deps),
    runId: RUN_ID,
    stderr: bufferStream().stream,
    mapError: (err) =>
      err instanceof StepError ? { code: EXIT.STEP_FAILURE, reason: err.message } : undefined,
    summary: { workflowName: wf, runDir: `.orch/state/${RUN_ID}` },
    beforeTeardown: (exitCode) => h.cmuxHost.notifyRunEnd(exitCode),
  })
}
