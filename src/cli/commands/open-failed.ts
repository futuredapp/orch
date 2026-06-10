// ---------------------------------------------------------------------------
// openFailed — re-open a `failed` run in the INTERACTIVE failure view (plan U6).
// ---------------------------------------------------------------------------
//
// The v2 fix for the most dangerous legacy behavior: `orch resume <failed-id>`
// used to *silently re-run the failed step* (the `executor.resume()` guard only
// fires on `completed`). This path instead PARKS at the existing `'failed'`
// view, now interactive, and lets the user decide:
//
//   - `[r]` retry the step      → `executor.retryStep()` (single-step, KTD-8):
//                                 re-run exactly the failed step, leave the run
//                                 `failed`, then REOPEN the view (the step now
//                                 shows ok, `[c]` still offered — AT-R1/R10a).
//   - `[c]` retry-and-continue  → the shared resume execution (KTD-5): re-run
//                                 the failed step and drive the workflow to
//                                 completion. A success fires `run:ended` +
//                                 flips the cmux pill `failed → completed`
//                                 (AT-R3/R11).
//   - `[q]`/detach              → dismiss. Taking NO action mutates nothing
//                                 (AT-R4) — the view loop never calls the
//                                 executor on a quit.
//
// The loop reopens a fresh viewer after each `[r]` (the steps-view child
// unmounts on an action — U5b), so each iteration re-projects the now-current
// `state.json`. A `[c]` exits the loop into the real continue.
//
// Side effects follow the actioned side-effects matrix at the top of plan
// Phase 2: an un-actioned open is pure; `[r]` writes only the step's retry
// attempt (no `run:ended`, no pill); `[c]`-to-completion is the only path that
// advances the run and flips the pill.

import {
  createResumeRegistry,
  defaultInstructionResolver,
  type InstructionResolver,
  type ResumeRegistry,
  type WorkflowArgs,
  type WorkflowDeps,
} from '../../core/index.ts'
import { type ForegroundAction, HostCreationError } from '../../hosts/index.ts'
import { instrumentProcessService } from '../../observability/index.ts'
import type { RunId, RunState } from '../../state/index.ts'
import { createTranscriptSidecar } from '../../state/index.ts'
import type { CliDeps } from '../deps.ts'
import { type CliOpts, EXIT, type HostFactory } from '../main.ts'
import { executeWithAttach } from './execute-with-attach.ts'
import { isLoadError, type LoadedWorkflow, loadWorkflow } from './load-workflow.ts'
import { rehydrateResumeRegistry } from './rehydrate-registry.ts'
import { relativeRunDir } from './relative-run-dir.ts'
import { mapResumeError, runResumeExecution } from './resume-execution.ts'

export interface OpenFailedArgs {
  readonly deps: CliDeps
  readonly targetId: RunId
  readonly state: RunState
  readonly workflowName: string
  readonly cliArgs: WorkflowArgs
  readonly opts: CliOpts
  readonly hostFactory: HostFactory
  /**
   * Pre-loaded workflow. When omitted, the workflow is loaded from disk via
   * `loadWorkflow` (the normal CLI path). Tests inject a `FakeRunner`-backed
   * executor here to drive the real retry/continue loop without a
   * `.orch/workflows/` file.
   */
  readonly loaded?: LoadedWorkflow
  /**
   * Live runner registry. The CLI leaves this absent (the park view creates one
   * and threads it into both rehydration and the host); tests inject one to
   * assert the cold park-view open rehydrated it for `⏎` resume.
   */
  readonly resumeRegistry?: ResumeRegistry
}

type ViewOutcome =
  | { readonly kind: 'action'; readonly action: ForegroundAction }
  | { readonly kind: 'dismissed' }
  | { readonly kind: 'error'; readonly code: number }

/**
 * Open a `failed` run in the interactive failure view and drive the
 * retry/continue loop until the user quits or a `[c]` reaches completion.
 */
export async function openFailed(args: OpenFailedArgs): Promise<number> {
  const { deps, targetId, state, workflowName, cliArgs, opts, hostFactory } = args

  // Load the workflow once — both `[r]` (retryStep) and `[c]` (resume re-run)
  // need the executor. A load error short-circuits before any viewer opens.
  const loaded = args.loaded ?? (await loadWorkflow(deps.cwd, workflowName))
  if (isLoadError(loaded)) return loaded.code

  // The manual-retry instruction source (D7 / U4). For now the built-in default
  // resolver delivers `'continue'` for both kinds; the sibling feature supplies
  // a configured schema against this same seam later.
  const instructionResolver: InstructionResolver = defaultInstructionResolver

  // Reopen after every `[r]`. A `[c]` returns out of the loop into the real
  // continue; a quit/detach returns `0`; a load/host error returns its code.
  for (;;) {
    const outcome = await openFailedView({
      deps,
      targetId,
      workflowName,
      opts,
      hostFactory,
      loaded,
      ...(args.resumeRegistry !== undefined ? { resumeRegistry: args.resumeRegistry } : {}),
    })
    if (outcome.kind === 'error') return outcome.code
    if (outcome.kind === 'dismissed') return EXIT.OK

    if (outcome.action === 'retry') {
      const retryCode = await runSingleStepRetry({
        deps,
        targetId,
        state,
        workflowName,
        opts,
        hostFactory,
        loaded,
        instructionResolver,
      })
      // A clean retry (passed or failed-again) leaves the run `failed` (KTD-8);
      // reopen so the view re-projects the now-current step state. A non-OK code
      // means the retry genuinely crashed — surface it and stop.
      if (retryCode !== EXIT.OK) return retryCode
      continue
    }

    // `[c]` retry-and-continue: re-run the failed step and drive to completion
    // via the shared resume execution (with cmux, so a success flips the pill).
    return runResumeExecution({
      deps,
      targetId,
      state,
      workflowName,
      cliArgs,
      opts,
      hostFactory,
      loaded,
      instructionResolver,
    })
  }
}

interface ViewArgs {
  readonly deps: CliDeps
  readonly targetId: RunId
  readonly workflowName: string
  readonly opts: CliOpts
  readonly hostFactory: HostFactory
  /** Pre-loaded workflow, forwarded to the registry rehydration so the park
   *  view can resolve a past interactive step's runner on `⏎`. */
  readonly loaded?: LoadedWorkflow
  /** Injected registry (tests assert it was rehydrated); the CLI creates one. */
  readonly resumeRegistry?: ResumeRegistry
}

/**
 * Mount the interactive failure viewer once and wait for the user to act. The
 * steps-view daemon tails the already-`failed` `state.json` and projects the
 * `'failed'` view with `[r]`/`[c]` affordances (enableFailureActions). No
 * executor runs here — a quit/detach is a pure observation.
 */
async function openFailedView(args: ViewArgs): Promise<ViewOutcome> {
  const { deps, targetId, workflowName, opts, hostFactory } = args

  process.stderr.write(`Opening run ${targetId} (failed) in interactive view...\n`)

  // A logger is required by the host factory, but the un-actioned open never
  // appends to it (no preamble, no run-end notify) — a pure open (AT-R4).
  const logger = deps.sessionLoggerFor(targetId)
  try {
    const resumeRegistry = args.resumeRegistry ?? createResumeRegistry()

    // Refill the registry from the persisted run so `⏎` on a past interactive
    // step resolves its runner (relaunch) instead of refusing — the park view
    // runs no executor of its own. Pure: a no-mutation replay (NullHost, no
    // logger). On a `failed` run it registers up to and including the failed
    // step, then stops before re-running it.
    await rehydrateResumeRegistry({
      deps,
      targetId,
      workflowName,
      resumeRegistry,
      opts,
      ...(args.loaded !== undefined ? { loaded: args.loaded } : {}),
    })

    let host: Awaited<ReturnType<HostFactory>>
    try {
      host = await hostFactory({
        runId: targetId,
        workflowName,
        stdout: process.stdout,
        stderr: process.stderr,
        clock: deps.clock,
        logger,
        processService: deps.processService,
        fs: deps.fsService,
        stateStore: deps.stateStore,
        resumeRegistry,
        // U6: surface the `[r]`/`[c]` keybindings + footer affordances in the
        // failure view. Only the CLI re-entry `failed` open sets this.
        enableFailureActions: true,
      })
    } catch (err) {
      if (err instanceof HostCreationError) {
        process.stderr.write(`${err.message}\n`)
        return { kind: 'error', code: EXIT.CONFIG_ERROR }
      }
      throw err
    }

    let action: ForegroundAction | undefined
    await executeWithAttach({
      host,
      workflow: Promise.resolve(),
      runId: targetId,
      stderr: process.stderr,
      mapError: () => undefined,
      summary: {
        workflowName,
        runDir: relativeRunDir(deps.cwd, deps.statePath, targetId),
      },
      logger,
      skipAttach: opts.noAttach,
      readOnly: true,
      onReadOnlyShutdown: (reason) => {
        if (typeof reason === 'object' && reason.type === 'action') action = reason.action
      },
    })

    return action === undefined ? { kind: 'dismissed' } : { kind: 'action', action }
  } finally {
    await logger.close()
  }
}

interface RetryArgs {
  readonly deps: CliDeps
  readonly targetId: RunId
  readonly state: RunState
  readonly workflowName: string
  readonly opts: CliOpts
  readonly hostFactory: HostFactory
  readonly loaded: LoadedWorkflow
  readonly instructionResolver: InstructionResolver
}

/**
 * `[r]`: re-run exactly the failed step via `executor.retryStep()` (single-step
 * park, KTD-8) on an attached, VISIBLE host — routed through `executeWithAttach`
 * exactly like `[c]` (`runResumeExecution`) and `orch retry`, so the user
 * watches the retry. It previously called `retryStep` directly and tore the
 * host down WITHOUT ever attaching, so the step re-executed into a detached
 * session: a blank screen for autonomous steps, and an interactive retried step
 * running into panes no human is attached to (Group 3). `executeWithAttach`
 * owns teardown on every path, so the loop reopens a fresh viewer afterward.
 *
 * No cmux host and no resume preamble: a retry-only action must not emit
 * `run:ended` or touch the status pill (the run stays `failed` until a real
 * `[c]` continue). The step's own retry attempt IS logged — that comes from the
 * executor's normal step path through the (logger-wired) host, which also
 * truncates and rewrites the per-step `formatted_output.*` tee so a later
 * `⏎`/`orch resume` replays the fresh attempt, not stale pre-retry bytes
 * (KTD-6). Returns `EXIT.OK` on a clean retried-ok/failed-again outcome; a
 * mapped non-OK code only on a genuine crash (`mapResumeError`).
 */
async function runSingleStepRetry(args: RetryArgs): Promise<number> {
  const { deps, targetId, state, workflowName, opts, hostFactory, loaded, instructionResolver } =
    args

  const logger = deps.sessionLoggerFor(targetId)
  try {
    const instrumentedProcess = instrumentProcessService(deps.processService, {
      logger,
      clock: deps.clock,
    })
    const resumeRegistry = createResumeRegistry()

    let host: Awaited<ReturnType<HostFactory>>
    try {
      host = await hostFactory({
        runId: targetId,
        workflowName,
        stdout: process.stdout,
        stderr: process.stderr,
        clock: deps.clock,
        logger,
        processService: instrumentedProcess,
        fs: deps.fsService,
        stateStore: deps.stateStore,
        resumeRegistry,
      })
    } catch (err) {
      if (err instanceof HostCreationError) {
        process.stderr.write(`${err.message}\n`)
        return EXIT.CONFIG_ERROR
      }
      throw err
    }

    const transcriptSidecar = createTranscriptSidecar({
      fs: deps.fsService,
      runId: targetId,
      basePath: deps.statePath,
    })

    const wfDeps: WorkflowDeps = {
      stateStore: deps.stateStore,
      processService: instrumentedProcess,
      clock: deps.clock,
      runId: targetId,
      cwd: deps.cwd,
      fsService: deps.fsService,
      gitService: deps.gitService,
      workflowName,
      // `[r]` uses the persisted args; the prompt-override semantics belong to
      // the `[c]`/resume continue path (`runResumeExecution`).
      args: state.args ?? {},
      host,
      transcriptSidecar,
      logger,
      promptService: deps.promptServiceFor(host.mode),
      interactivity: opts.interactivity,
      resumeRegistry,
      instructionResolver,
    }

    // `retryStep` resolves with a `RetryStepResult` (`retried-ok`/`failed-again`,
    // never throwing on a step-level re-failure); the loop only needs the exit
    // code, so adapt it to the `Promise<void>` the race expects. A genuine crash
    // throws and is classified by `mapResumeError` inside `executeWithAttach`.
    return await executeWithAttach({
      host,
      workflow: loaded.executor.retryStep(wfDeps).then(() => {}),
      runId: targetId,
      stderr: process.stderr,
      mapError: mapResumeError,
      summary: {
        workflowName,
        runDir: relativeRunDir(deps.cwd, deps.statePath, targetId),
      },
      logger,
      skipAttach: opts.noAttach,
      readOnly: false,
    })
  } finally {
    await logger.close()
  }
}
