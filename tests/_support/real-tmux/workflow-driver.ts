// Workflow driver — mounts a real TmuxHost on the harness fixture, exposes
// left/right pane handles, and runs a sequence of steps with a per-step
// agent (Runner) slot.
//
// The shape lets a Tier 1 test scripted with `FakeRunner` and a Tier 4 test
// using a real `ClaudeRunner` share the exact same body: only the agent slot
// on each `HarnessStep` differs. The driver does not synthesize an agent of
// its own — every step's runner is whatever the caller passed in.

import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import { Writable } from 'node:stream'
import { parallel } from '../../../src/core/parallel.ts'
import { step } from '../../../src/core/step.ts'
import type { StepMode } from '../../../src/core/types.ts'
import type { RunOverrides, WorkflowDeps } from '../../../src/core/workflow.ts'
import { workflow } from '../../../src/core/workflow.ts'
import type { Host } from '../../../src/hosts/index.ts'
import { createTmuxHost } from '../../../src/hosts/index.ts'
import { createFileSessionLogger, type SessionLogger } from '../../../src/observability/index.ts'
import type { Runner } from '../../../src/runners/index.ts'
import {
  ORCH_LIFECYCLE_SCRIPT_ENV,
  scriptedFake,
} from '../../../src/runners/scripted-fake/index.ts'
import { FakeGitService, type ProcessService } from '../../../src/services/index.ts'
import { FakePromptService } from '../../../src/services/prompt/index.ts'
import { type PaneId, paneId as toPaneId } from '../../../src/services/tmux/index.ts'
import { path as toPath } from '../../../src/services/types.ts'
import { FileStateStore } from '../../../src/state/index.ts'
import { type AgentHandle, createAgentHandle } from './agent-handle.ts'
import type { RealTmuxFixture } from './fixture.ts'
import { type NamedKey, sendKeysToPane } from './keys.ts'
import { createPaneHandle, type PaneHandle } from './pane-handle.ts'

const SESSION = 'orch'

// ---------------------------------------------------------------------------
// Shared scripted-fake script provisioning.
//
// The scripted-fake entry reads its step declarations from a single JSON file
// pointed to by ORCH_LIFECYCLE_SCRIPT (process env). Multiple in-process
// harnesses (e.g. two concurrent runs in one F2 test) therefore share that one
// env var, so we merge every harness's puppet step declarations into ONE
// per-process file rather than letting harnesses clobber each other. The
// declarations are run-agnostic (`{ kind: 'puppet' }`, no controlPath) — each
// run's control path is derived from its own ORCH_RUN_STATE_DIR (U1/U3), so a
// shared declaration file preserves per-run isolation.
const SHARED_SCRIPT_PATH = nodePath.join(
  tmpdir(),
  `orch-real-tmux-scripted-fake-${process.pid}.json`,
)
const sharedScriptSteps: Record<string, { readonly kind: 'puppet' }> = {}

async function provisionPuppetScript(stepNames: readonly string[]): Promise<void> {
  for (const name of stepNames) sharedScriptSteps[name] = { kind: 'puppet' }
  await writeFile(SHARED_SCRIPT_PATH, JSON.stringify({ steps: sharedScriptSteps }), 'utf-8')
  process.env[ORCH_LIFECYCLE_SCRIPT_ENV] = SHARED_SCRIPT_PATH
}

/**
 * One predictable-fake step in a puppet workflow. `name` is the step's
 * define-name (also the scripted-fake script row). `as` is the stable label
 * that becomes the run-time key (`deriveStepKey`: `as` wins) — required to make
 * parallel branches individually addressable (R9). The agent handle is fetched
 * by `as ?? name`.
 */
export interface PuppetStepSpec {
  readonly name: string
  readonly as?: string
  /** Defaults to autonomous (headless). Interactive is Phase 2 (U4). */
  readonly mode?: StepMode
  /**
   * Interactive pane UI, only consulted when `mode: 'interactive'`. `'raw'`
   * (default) drives the deterministic line-printer entry; `'ink'` drives the
   * Ink list+input entry. Forwarded to `scriptedFake({ interactiveUi })`.
   */
  readonly ui?: 'raw' | 'ink'
}

/** A sequential step, or a set of branches to run via `parallel([...])`. */
export type PuppetWorkflowItem = PuppetStepSpec | { readonly parallel: readonly PuppetStepSpec[] }

function specNames(items: readonly PuppetWorkflowItem[]): string[] {
  const names: string[] = []
  for (const item of items) {
    if ('parallel' in item) names.push(...item.parallel.map((s) => s.name))
    else names.push(item.name)
  }
  return names
}

function allSpecs(items: readonly PuppetWorkflowItem[]): PuppetStepSpec[] {
  const specs: PuppetStepSpec[] = []
  for (const item of items) {
    if ('parallel' in item) specs.push(...item.parallel)
    else specs.push(item)
  }
  return specs
}

// Two specs that resolve to the same control-file key (`as ?? name`) would
// silently share ONE control file — an `agent(label)` handle could not address
// them independently and their acks/render would interleave. Detect the
// collision up front and throw a clear error (mirrors the spirit of the
// executor's R20 `StepNameCollisionError`) instead of letting it pass silently.
function assertNoDuplicateLabels(items: readonly PuppetWorkflowItem[]): void {
  const seen = new Set<string>()
  for (const spec of allSpecs(items)) {
    const label = spec.as ?? spec.name
    if (seen.has(label)) {
      throw new Error(
        `runPuppetWorkflow: two workflow items resolve to the same control-file key ${JSON.stringify(label)} — give each a distinct \`as:\` so its agent() handle can address it independently`,
      )
    }
    seen.add(label)
  }
}

export interface HarnessStep {
  /** Step name (e.g. `'plan'`). Becomes the StepName. */
  readonly name: string
  /** Runner driving this step. FakeRunner for Tier 1, real Runner for Tier 4. */
  readonly agent: Runner
  /** Step mode override. Defaults to runner's default (usually `'autonomous'`). */
  readonly mode?: StepMode
  /** Optional prompt forwarded to the runner. */
  readonly prompt?: string
  /** Interactive auto-stop opt-in. Only valid with `mode: 'interactive'`. */
  readonly autoStop?: boolean
}

export interface MountedHarness {
  readonly host: Host
  readonly left: PaneHandle
  readonly right: PaneHandle
  readonly logger: SessionLogger
  readonly stateStore: FileStateStore
  /** Send a named key or literal text to a specific pane. */
  sendKeysToPaneId(target: PaneId, input: NamedKey | string): Promise<void>
  /** Convenience: send to the left pane (steps view). */
  sendKeys(input: NamedKey | string): Promise<void>
  /** Execute the supplied steps in order through a real workflow body. */
  runWorkflow(steps: readonly HarnessStep[]): Promise<RunWorkflowResult>
  /**
   * Execute a workflow of predictable-fake (scripted-fake puppet) steps, each
   * drivable via `agent(label)`. Sequential items run in order; a `{ parallel }`
   * item runs its branches concurrently. Returns the run promise — hold it,
   * drive the instances via their handles, then await it.
   */
  runPuppetWorkflow(items: readonly PuppetWorkflowItem[]): Promise<RunWorkflowResult>
  /**
   * Per-instance handle for the predictable fake addressed by the author's
   * label (the run-time key — flat `as:` label or `sub>name`). Bound to THIS
   * harness's `runId`, so two harnesses' handles never resolve each other's
   * control files (structural R11 isolation). Named distinctly from the
   * `left`/`right` pane handles.
   */
  agent(labelPath: string): AgentHandle
  /** Tear down host + logger. Does not dispose the underlying fixture — caller owns that. */
  teardown(): Promise<void>
}

export interface RunWorkflowResult {
  readonly completed: boolean
  /** Surface for tests that want to see the thrown error rather than treat it as a failure. */
  readonly error?: unknown
}

export interface MountTmuxHostOptions {
  readonly workflowName?: string
  /**
   * Renderer used by the right-pane-controller to format autonomous-agent
   * transcripts on Enter-to-inspect. Defaults to the agent's own
   * `toTranscriptLines` when the workflow uses a single runner.
   */
  readonly transcriptRenderer?: Runner['toTranscriptLines']
  /**
   * When true, the steps-view daemon is not started. Use for tests that
   * only care about the right pane (autonomous live output). Default is
   * `false` — the steps view runs and the left pane shows it.
   */
  readonly disableStepsView?: boolean
  /**
   * Process service used by the workflow's agent (Runner). FakeRunner stubs
   * its argv on a FakeProcessService; real runners need BunProcessService.
   * Defaults to the fixture's processService (BunProcessService), which is
   * the right default for Tier 4. Tier 1 tests pass a FakeProcessService
   * here so FakeRunner's `.script(...)` responses get picked up.
   *
   * The tmux service always uses the fixture's processService — only the
   * agent runner reads this slot.
   */
  readonly agentProcessService?: ProcessService
}

/**
 * Mounts a TmuxHost on the fixture's services and exposes typed handles
 * for both panes plus a workflow runner. The returned `MountedHarness`
 * does not own the fixture — callers must still dispose the fixture
 * themselves (typically via `afterEach`).
 */
export async function mountTmuxHost(
  fixture: RealTmuxFixture,
  opts: MountTmuxHostOptions = {},
): Promise<MountedHarness> {
  const workflowName = opts.workflowName ?? 'harness-workflow'
  const basePath = toPath(`${fixture.stateBase}/.orch/state`)

  const logger = createFileSessionLogger({
    fs: fixture.fs,
    clock: fixture.clock,
    runId: fixture.runId,
    basePath,
    debug: false,
  })
  const stateStore = new FileStateStore({ fs: fixture.fs, basePath })

  const host = await createTmuxHost({
    tmux: fixture.tmux,
    socket: fixture.socket,
    processService: fixture.processService,
    clock: fixture.clock,
    runId: fixture.runId,
    workflowName,
    stderr: silentStream(),
    skipVersionCheck: true,
    skipAttach: true,
    logger,
    basePath,
    stateStore,
    fs: fixture.fs,
    disableStepsView: opts.disableStepsView === true,
    ...(opts.transcriptRenderer !== undefined
      ? { transcriptRenderer: opts.transcriptRenderer }
      : {}),
  })

  // createTmuxHost has already split the right pane and bound the strict-
  // sandbox config. listPanes returns them in window order (left, right).
  // The pane id at *index 1* of the orch session is the visible right slot;
  // it changes whenever the right-pane controller swaps a hidden source in.
  const resolveLeftPaneId = async (): Promise<PaneId> => {
    const panes = await fixture.tmux.listPanes({
      socket: fixture.socket,
      session: SESSION,
      format: '#{pane_id}',
    })
    const first = panes[0]
    if (first === undefined) {
      throw new Error('mountTmuxHost: orch session has no panes')
    }
    return toPaneId(first)
  }
  const resolveRightPaneId = async (): Promise<PaneId> => {
    const panes = await fixture.tmux.listPanes({
      socket: fixture.socket,
      session: SESSION,
      format: '#{pane_id}',
    })
    const second = panes[1]
    if (second === undefined) {
      throw new Error('mountTmuxHost: orch session has fewer than 2 panes')
    }
    return toPaneId(second)
  }

  // Resolve once at mount to fail fast if createTmuxHost left the session
  // in an unexpected shape.
  await resolveLeftPaneId()
  await resolveRightPaneId()

  const left = createPaneHandle({
    tmux: fixture.tmux,
    socket: fixture.socket,
    resolvePaneId: resolveLeftPaneId,
    label: 'left',
  })
  const right = createPaneHandle({
    tmux: fixture.tmux,
    socket: fixture.socket,
    resolvePaneId: resolveRightPaneId,
    label: 'right',
  })

  const sendKeysToPaneId = (target: PaneId, input: NamedKey | string): Promise<void> =>
    sendKeysToPane({ tmux: fixture.tmux, socket: fixture.socket, target }, input)
  const sendKeys = async (input: NamedKey | string): Promise<void> => {
    const leftPaneId = await resolveLeftPaneId()
    await sendKeysToPaneId(leftPaneId, input)
  }

  const agentProcessService = opts.agentProcessService ?? fixture.processService

  const makeDeps = (): WorkflowDeps => ({
    stateStore,
    processService: agentProcessService,
    clock: fixture.clock,
    runId: fixture.runId,
    cwd: toPath(String(fixture.stateBase)),
    fsService: fixture.fs,
    gitService: new FakeGitService(),
    host,
    promptService: new FakePromptService(),
    interactivity: 'interactive',
    logger,
    workflowName,
  })

  const execute = async (body: (run: WorkflowRun) => Promise<void>): Promise<RunWorkflowResult> => {
    try {
      await workflow(workflowName, body).execute(makeDeps())
      return { completed: true }
    } catch (error) {
      return { completed: false, error }
    }
  }

  const runWorkflow = (steps: readonly HarnessStep[]): Promise<RunWorkflowResult> =>
    execute(buildWorkflowBody(steps))

  const runPuppetWorkflow = async (
    items: readonly PuppetWorkflowItem[],
  ): Promise<RunWorkflowResult> => {
    assertNoDuplicateLabels(items)
    await provisionPuppetScript(specNames(items))
    return execute(buildPuppetBody(items))
  }

  const agent = (labelPath: string): AgentHandle =>
    createAgentHandle({
      runStateDir: String(stateStore.runDir(fixture.runId)),
      key: labelPath,
    })

  let tornDown = false
  const teardown = async (): Promise<void> => {
    if (tornDown) return
    tornDown = true
    await host.teardown().catch(() => {})
    await logger.close().catch(() => {})
  }

  return {
    host,
    left,
    right,
    logger,
    stateStore,
    sendKeysToPaneId,
    sendKeys,
    runWorkflow,
    runPuppetWorkflow,
    agent,
    teardown,
  }
}

function silentStream(): NodeJS.WritableStream {
  return new Writable({
    write(_chunk, _enc, cb) {
      cb()
    },
  }) as unknown as NodeJS.WritableStream
}

type WorkflowRun = Parameters<Parameters<typeof workflow>[1]>[0]

// Define and run one harness step, forwarding only the overrides that are set.
// Extracted from buildWorkflowBody's closure to keep it under the rule-5 budget.
async function runHarnessStep(run: WorkflowRun, harnessStep: HarnessStep): Promise<void> {
  const overrides: RunOverrides = {
    ...(harnessStep.prompt !== undefined ? { prompt: harnessStep.prompt } : {}),
    ...(harnessStep.mode !== undefined ? { mode: harnessStep.mode } : {}),
  }
  await run(
    step.define(harnessStep.name, {
      agent: harnessStep.agent,
      ...(harnessStep.prompt !== undefined ? { prompt: harnessStep.prompt } : {}),
      ...(harnessStep.mode !== undefined ? { mode: harnessStep.mode } : {}),
      ...(harnessStep.autoStop !== undefined ? { autoStop: harnessStep.autoStop } : {}),
    } as Parameters<typeof step.define>[1]),
    overrides,
  )
}

function buildWorkflowBody(steps: readonly HarnessStep[]): (run: WorkflowRun) => Promise<void> {
  return async (run) => {
    for (const harnessStep of steps) {
      await runHarnessStep(run, harnessStep)
    }
  }
}

// Run one predictable-fake spec: a scripted-fake puppet step, with the spec's
// `as` label flowing into deriveStepKey so the agent handle can address it.
// `mode: 'interactive'` constructs an interactive runner (U4) — `supports.
// interactive` is frozen at construction, so the mode is baked into the runner
// here, not toggled at run time. Interactive steps cannot appear inside
// `parallel()` (the executor's InteractiveParallelError), so they must be
// sequential items.
function runPuppetSpec(run: WorkflowRun, spec: PuppetStepSpec): Promise<unknown> {
  const interactive = spec.mode === 'interactive'
  const overrides: RunOverrides = {
    ...(spec.as !== undefined ? { as: spec.as } : {}),
    ...(spec.mode !== undefined ? { mode: spec.mode } : {}),
  }
  const defined = step.define(spec.name, {
    agent: scriptedFake({
      stepName: spec.name,
      interactive,
      ...(spec.ui !== undefined ? { interactiveUi: spec.ui } : {}),
    }),
    ...(spec.mode !== undefined ? { mode: spec.mode } : {}),
  } as Parameters<typeof step.define>[1])
  return run(defined, overrides)
}

function buildPuppetBody(
  items: readonly PuppetWorkflowItem[],
): (run: WorkflowRun) => Promise<void> {
  return async (run) => {
    for (const item of items) {
      if ('parallel' in item) {
        await parallel(item.parallel.map((spec) => runPuppetSpec(run, spec)))
      } else {
        await runPuppetSpec(run, item)
      }
    }
  }
}
