import { randomUUID } from 'node:crypto'
import { SubworkflowDepthError } from './errors.ts'
import {
  currentSubworkflowDepth,
  type ExecutionContext,
  executionContext,
} from './execution-context.ts'
import {
  bodyHandle,
  DEFAULT_MAX_SUBWORKFLOW_DEPTH,
  type StepLifecycleEvent,
  type WorkflowArgs,
  type WorkflowExecutor,
} from './workflow.ts'

// ---------------------------------------------------------------------------
// runWorkflow — inline-equivalent subworkflow composition (R1-R21)
// ---------------------------------------------------------------------------
//
// Pushes a fresh ALS sub-frame, enforces the depth bound, emits
// `subworkflow:enter` / `subworkflow:exit` lifecycle events (R14), invokes
// the sub body via its module-private symbol handle (R18-R19), and
// propagates errors per R10. Same `runId`, same state store, same logs,
// same captureLock as the parent — the only deliberate divergences from
// literal inline equivalence are (a) the new ALS frame so a sub's
// `setWorkflowCwd` cannot leak back to its caller, and (b) the bounded
// `enter/exit` lifecycle events that hosts and `lifecycle.ndjson` render
// as a visible boundary.
//
// Lives in its own file because `src/core/workflow.ts` is already
// 1400+ LOC (CLAUDE.md rule 5 caps at 300; the executor itself is over).

export async function runWorkflow<Args extends WorkflowArgs>(
  executor: WorkflowExecutor<Args>,
  args: NoInfer<Args>,
): Promise<void> {
  // R2 — outside-scope guard. `runWorkflow` requires an active workflow
  // ALS frame; called from top-level user code (no enclosing workflow body)
  // it throws with a clear message rather than minting an isolated child
  // run. Mirrors `setWorkflowCwd`'s outside-scope guard.
  const parent = executionContext.getStore()
  if (parent === undefined) {
    throw new Error('runWorkflow() called outside an active workflow execution')
  }

  const parentRun = parent.runFnRef
  if (parentRun === undefined) {
    // Defensive guard — `runFnRef` is populated at workflow-root construction
    // (`executeWorkflowFn` in workflow.ts) and propagated through parallel
    // branches. If we get here, an executor entry path forgot to populate
    // it; throwing with a clear message beats threading a non-null assert.
    throw new Error(
      'runWorkflow() called from a frame missing runFnRef — workflow-root construction is incomplete',
    )
  }

  // R21 — depth guard. Reads the per-execution snapshot from the parent
  // frame so concurrent executions can carry different bounds. Throws
  // BEFORE the enter event fires so the parent's failure classifier sees
  // `SubworkflowDepthError` (which omitting from `isStepLevelFailure`
  // classifies as `'crashed'`, not `'failed'`).
  const newDepth = currentSubworkflowDepth() + 1
  const maxDepth = parent.maxSubworkflowDepth ?? DEFAULT_MAX_SUBWORKFLOW_DEPTH
  if (newDepth > maxDepth) {
    throw new SubworkflowDepthError(newDepth, maxDepth, [
      ...(parent.subworkflowPath ?? []),
      executor.name,
    ])
  }

  // R8, R11, R12, R13, R23 — sub-frame construction. Most fields are
  // inherited by reference (host port, parallel marker, parallel-block id);
  // `workflowCwd` is COPIED BY VALUE so `setWorkflowCwd` inside the sub
  // cannot leak back to the parent; `subworkflowDepth` and
  // `subworkflowPath` are pushed-new; `insideParallel` propagates downward
  // so the sub-of-sub subtree renders uniformly.
  const subPath = [...(parent.subworkflowPath ?? []), executor.name]
  const subFrame: ExecutionContext = {
    parallelDepth: parent.parallelDepth,
    ...(parent.homogeneousBranch !== undefined
      ? { homogeneousBranch: parent.homogeneousBranch }
      : {}),
    ...(parent.emitLifecycle !== undefined ? { emitLifecycle: parent.emitLifecycle } : {}),
    ...(parent.parallelBlockIdRef !== undefined
      ? { parallelBlockIdRef: parent.parallelBlockIdRef }
      : {}),
    ...(parent.workflowCwd !== undefined ? { workflowCwd: parent.workflowCwd } : {}),
    subworkflowDepth: newDepth,
    subworkflowPath: subPath,
    subCallId: randomUUID(),
    runFnRef: parentRun,
    ...(parent.loggerRef !== undefined ? { loggerRef: parent.loggerRef } : {}),
    ...(parent.maxSubworkflowDepth !== undefined
      ? { maxSubworkflowDepth: parent.maxSubworkflowDepth }
      : {}),
    ...(parent.insideParallel === true || parent.parallelDepth > 0
      ? { insideParallel: true as const }
      : {}),
  }

  const insideParallel = subFrame.insideParallel === true
  const startedAt = Date.now()

  // R14, R15, R17 — emit `subworkflow:enter`. Host throws on this event
  // propagate (the sub body does NOT run); the orchestrator's lifecycle log
  // still gets the record because we append BEFORE the host fan-out. The
  // ordering matters: log first so a host crash on enter still leaves a
  // trace, then host (which may throw and short-circuit).
  const enterEvent: StepLifecycleEvent = {
    type: 'subworkflow:enter',
    name: executor.name,
    depth: newDepth,
    subPath,
    ...(insideParallel ? { insideParallel: true as const } : {}),
  }
  void parent.loggerRef?.append('lifecycle', enterEvent).catch(() => {})
  try {
    parent.emitLifecycle?.(enterEvent)
  } catch (hostErr) {
    const durationMs = Date.now() - startedAt
    const hostMessage = hostErr instanceof Error ? hostErr.message : String(hostErr)
    const hostErrorEvent: StepLifecycleEvent = {
      type: 'host-error',
      source: 'subworkflow:enter',
      name: executor.name,
      depth: newDepth,
      message: hostMessage,
    }
    const exitEvent: StepLifecycleEvent = {
      type: 'subworkflow:exit',
      name: executor.name,
      depth: newDepth,
      subPath,
      durationMs,
      outcome: 'failed',
      ...(insideParallel ? { insideParallel: true as const } : {}),
    }
    void parent.loggerRef?.append('lifecycle', hostErrorEvent).catch(() => {})
    void parent.loggerRef?.append('lifecycle', exitEvent).catch(() => {})
    try {
      parent.emitLifecycle?.(hostErrorEvent)
    } catch {
      // Preserve the original host-enter failure. The host-error event has
      // already been written to lifecycle logs when a logger is configured.
    }
    throw hostErr
  }

  let outcome: 'completed' | 'failed' = 'completed'
  let thrown: unknown
  try {
    await executionContext.run(subFrame, () => executor[bodyHandle](parentRun, args))
  } catch (err) {
    outcome = 'failed'
    thrown = err
  }

  const durationMs = Date.now() - startedAt
  const exitEvent: StepLifecycleEvent = {
    type: 'subworkflow:exit',
    name: executor.name,
    depth: newDepth,
    subPath,
    durationMs,
    outcome,
    ...(insideParallel ? { insideParallel: true as const } : {}),
  }
  void parent.loggerRef?.append('lifecycle', exitEvent).catch(() => {})
  // R10 host-error asymmetry — host throws on exit are SUPPRESSED. Emit a
  // typed `host-error` record so the post-hoc trace exists (resolves the
  // 2026-05-31 R10 observability gap). The sub's outcome (success or
  // failure) propagates to the parent regardless of the host throw.
  try {
    parent.emitLifecycle?.(exitEvent)
  } catch (hostErr) {
    const hostMessage = hostErr instanceof Error ? hostErr.message : String(hostErr)
    const hostErrorEvent: StepLifecycleEvent = {
      type: 'host-error',
      source: 'subworkflow:exit',
      name: executor.name,
      depth: newDepth,
      message: hostMessage,
    }
    void parent.loggerRef?.append('lifecycle', hostErrorEvent).catch(() => {})
    try {
      parent.emitLifecycle?.(hostErrorEvent)
    } catch {
      // A host throwing on host-error itself is a no-op — we have already
      // recorded the original failure to the log; further escalation would
      // mask the sub's actual outcome.
    }
  }

  if (outcome === 'failed') throw thrown
}
