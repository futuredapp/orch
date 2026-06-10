// ---------------------------------------------------------------------------
// rehydrateResumeRegistry — refill the live runner registry on a COLD open.
// ---------------------------------------------------------------------------
//
// When a finished run is re-opened from a fresh process (`orch resume
// <completed-id>` → `openFinished`, or the `failed` park view), there is no
// executor running to populate the `ResumeRegistry` the way a live run does.
// Without this, the right-pane controller has no runner to resolve when the
// user presses `⏎` on a past INTERACTIVE step, and refused with the misleading
// "resume not ready yet — try again in a moment" (the executor will never
// replay on a read-only open, so "in a moment" never arrives).
//
// This helper loads the workflow and runs `executor.populateResumeRegistry` —
// a no-mutation replay that registers each interactive step's runner from the
// cache and executes NOTHING. It is best-effort: if the workflow can't be
// loaded (e.g. opening a run from outside its project), the registry stays
// empty and `⏎` falls back to the existing refusal — exactly today's behavior.
//
// The pure-open contract (AT-5/AT-14/AT-15/AT-17) is preserved: the replay runs
// against a `NullHost` (no lifecycle leaks into the real viewer) and NO logger
// (no `logs/` writes), reads `state.json` without mutating it, and invokes no
// runner.

import type { ResumeRegistry, WorkflowDeps } from '../../core/index.ts'
import { createNullHost } from '../../hosts/index.ts'
import type { RunId } from '../../state/index.ts'
import type { CliDeps } from '../deps.ts'
import type { CliOpts } from '../main.ts'
import { isLoadError, type LoadedWorkflow, loadWorkflow } from './load-workflow.ts'

export interface RehydrateResumeRegistryArgs {
  readonly deps: CliDeps
  readonly targetId: RunId
  readonly workflowName: string
  readonly resumeRegistry: ResumeRegistry
  readonly opts: CliOpts
  /**
   * Pre-loaded workflow. The CLI leaves this absent (the helper loads from
   * `.orch/`); tests inject a `FakeRunner`-backed executor so they can seed a
   * finished run via the fixture without a real workflow file on disk.
   */
  readonly loaded?: LoadedWorkflow
}

/**
 * Populate `resumeRegistry` from the persisted run so the right pane can
 * resolve a past interactive step's runner on `⏎`. Best-effort and silent on
 * failure — a missing/unloadable workflow leaves the registry empty.
 */
export async function rehydrateResumeRegistry(args: RehydrateResumeRegistryArgs): Promise<void> {
  const { deps, targetId, workflowName, resumeRegistry, opts } = args

  // Quiet load: a read-only open whose workflow can't be found (wrong cwd,
  // deleted file) must degrade silently — no alarming "Cannot load config" line
  // on an otherwise-clean open.
  const loaded = args.loaded ?? (await loadWorkflow(deps.cwd, workflowName, { quiet: true }))
  if (isLoadError(loaded)) return

  const state = await deps.stateStore.loadRun(targetId)

  const wfDeps: WorkflowDeps = {
    stateStore: deps.stateStore,
    // Raw (un-instrumented) services: the replay touches no subprocess and
    // writes no state, so there is nothing to instrument or log.
    processService: deps.processService,
    clock: deps.clock,
    runId: targetId,
    cwd: deps.cwd,
    fsService: deps.fsService,
    gitService: deps.gitService,
    workflowName,
    // Replay with the run's persisted args so the body takes the same branches
    // and reaches the same cache keys it did live.
    args: state?.args ?? {},
    host: createNullHost(),
    promptService: deps.promptServiceFor('two-pane'),
    interactivity: opts.interactivity,
    resumeRegistry,
    // No logger: a cold open is a pure observation (AT-17 — `logs/` unchanged).
  }

  try {
    await loaded.executor.populateResumeRegistry(wfDeps)
  } catch {
    // Best-effort: a body that throws during replay (or any unexpected error)
    // must not break the read-only open — the registry just stays partial and
    // `⏎` falls back to the existing refusal.
  }
}
