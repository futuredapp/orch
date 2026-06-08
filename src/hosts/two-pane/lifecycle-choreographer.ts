// ---------------------------------------------------------------------------
// LifecycleChoreographer — owns the right-pane reaction to StepLifecycleEvents.
// ---------------------------------------------------------------------------
//
// Extracted from `tmux-host.ts`'s inline `onLifecycleEvent` (the repo's
// densest, previously untested behaviour). The host's handler now collapses to
// a one-line `void choreographer.handle(event)`; this module owns the ordered
// choreography that translates each `StepLifecycleEvent` into per-step tee
// writes, right-pane source register/unregister, failure banners, and the
// parallel-block rollup.
//
// **FIFO serialization.** `Host.onLifecycleEvent` is `void` by contract — the
// executor fires events without awaiting. Each `handle(event)` chains on an
// internal tail promise so every event's side effects fully settle before the
// next begins. This turns each "unregister BEFORE close" / "summary BEFORE
// freeze" comment into an invariant that holds *across* events, not just
// within one. Strict FIFO is a deliberate behavioural change from the old
// best-effort interleave: lifecycle events are infrequent and only drive
// right-pane rendering, and the executor never awaits `onLifecycleEvent`, so a
// slow queue never stalls workflow execution.
//
// **Never poisons.** A raw rejected `tail` would silently skip every later
// event. Each link swallows into `onSendError`, and each individual controller
// call also routes its own rejection there, so one failed event never starves
// the queue and one failed call inside an event never aborts the rest of that
// event's choreography.

import { summarizeFailure } from '../../core/failure-summary.ts'
import { metaStepName, type RunId } from '../../core/types.ts'
import type { StepLifecycleEvent } from '../../core/workflow.ts'
import type { SessionLogger } from '../../observability/index.ts'
import type { Clock } from '../../services/clock/index.ts'
import { type PerStepTee, teePathFor } from '../plain/per-step-tee.ts'
import { renderFailurePanePayload } from './failure-pane.ts'
import type { RightPaneController } from './pane-map/index.ts'
import { createRollupAggregator, renderRollupPayload } from './parallel-rollup.ts'

// Fixed meta step key for the parallel-block rollup tee + hidden pane. Leading
// underscore keeps it out of the user-facing `stepName()` namespace and sorts
// above step names in directory listings. (Moved here from `tmux-host.ts` with
// the choreography it belongs to.)
const ROLLUP_STEP_NAME = metaStepName('_rollup')

export interface LifecycleChoreographerDeps {
  /**
   * Right-pane controller. `undefined` for fixtures that construct the host
   * without a steps-view daemon (no `basePath` / `stateStore`). Tee effects
   * run regardless of controller presence; the `?.` guards mirror the inline
   * handler's behaviour.
   */
  readonly controller: RightPaneController | undefined
  /** Per-step formatted_output tee, shared with the host's runner/command writes. */
  readonly tee: PerStepTee
  /** Session logger — read only via `teePathFor` to resolve the live tee path. */
  readonly logger: SessionLogger | undefined
  readonly runId: RunId
  readonly clock: Clock
  /**
   * Reads the host's live `torndown` flag at process time. Only the
   * `step:failed` branch consults it (to skip the failure-summary write during
   * teardown); ownership stays on the host.
   */
  readonly isTorndown: () => boolean
  /**
   * Sink for any rejection raised while processing an event. In the host this
   * is `handleSendError`, which no-ops after teardown and otherwise writes to
   * stderr.
   */
  readonly onSendError: (err: unknown) => void
}

export interface LifecycleChoreographer {
  /**
   * Enqueue an event's choreography behind the FIFO tail. Returns a promise
   * that resolves when this event's side effects have fully settled. Never
   * rejects.
   */
  handle(event: StepLifecycleEvent): Promise<void>
  /** Resolve once the current tail of queued work has drained. Never rejects. */
  quiescent(): Promise<void>
}

export function createLifecycleChoreographer(
  deps: LifecycleChoreographerDeps,
): LifecycleChoreographer {
  const { controller, tee, logger } = deps
  // Owned here — the rollup aggregator has no other consumer now that the
  // choreography lives in this module.
  const rollup = createRollupAggregator()

  // Each branch awaits its controller calls in sequence; the FIFO queue
  // guarantees one event's choreography fully settles before the next begins.
  // Every controller call routes its own rejection to `onSendError`, so one
  // failed call never aborts the rest of an event's choreography (matching the
  // inline handler's per-call `.catch(handleSendError)` isolation).
  //
  // Exceeds the 60-line function guidance (CLAUDE.md §5): it is a flat
  // one-branch-per-event-type dispatcher whose value is reading the seven
  // choreographies side by side in one place. Splitting each branch into a
  // helper would scatter the ordering story across the file for no gain.
  const process = async (event: StepLifecycleEvent): Promise<void> => {
    if (event.type === 'step:start') {
      if (event.mode !== 'autonomous') return
      tee.open(event.stepName)
      // Force the tee file into existence with a visible marker so the live
      // `tail -F` source has bytes to render immediately. Runners can take
      // 5–25 s to emit their first transcript-renderable event; without this,
      // the right pane stays blank long enough that users navigate away.
      tee.write(event.stepName, `[${event.stepName}] starting…\r\n`)
      const teePath = teePathFor(logger, event.stepName)
      if (teePath !== null) {
        await controller
          ?.registerSource(
            { type: 'live', stepName: event.stepName },
            { kind: 'file-tail', path: teePath },
          )
          .catch(deps.onSendError)
      } else if (controller !== undefined) {
        // No file logging configured — the tee writes are a no-op; surface that
        // to the user so the empty right pane has a one-time explanation.
        await controller
          .emitBanner({
            kind: 'info',
            text: `step ${event.stepName} running (no transcript captured — file logging disabled)`,
            ttlMs: 4000,
          })
          .catch(deps.onSendError)
      }
      return
    }
    if (event.type === 'step:cached') {
      // Cached steps never run on the right pane — surface the cache hit as a
      // transient info banner so the user understands why no transcript appeared.
      await controller
        ?.emitBanner({
          kind: 'info',
          text: `step ${event.stepName} — cached (no transcript captured)`,
          ttlMs: 4000,
        })
        .catch(deps.onSendError)
      return
    }
    if (event.type === 'step:complete') {
      // Ordering: unregister BEFORE close. The controller's `live → replay`
      // transform leaves the hidden pane tailing the tee; bytes written between
      // unregister and close still surface in the warm-cached replay.
      const teePath = teePathFor(logger, event.stepName)
      if (teePath !== null && controller !== undefined) {
        await controller
          .unregisterSource({ type: 'live', stepName: event.stepName })
          .catch(deps.onSendError)
      }
      tee.close(event.stepName)
      return
    }
    if (event.type === 'step:failed') {
      // tee.write the failure summary FIRST so the bytes land in the file (and
      // therefore in the hidden pane still tailing it) before the live → replay
      // transform freezes the source for warm replay.
      if (!deps.isTorndown()) {
        const summary = summarizeFailure({
          stepName: event.stepName,
          runId: deps.runId,
          error: event.error,
          failedAt: deps.clock.now(),
        })
        tee.write(event.stepName, renderFailurePanePayload(summary))
      }
      const teePath = teePathFor(logger, event.stepName)
      if (teePath !== null && controller !== undefined) {
        // Sequential: drain the unregister (with the completion banner
        // suppressed at the source) BEFORE the error emit, so a slow
        // pendingRegistrations drain can't land its info banner after our error
        // and overwrite it. The FIFO queue then guarantees `tee.close` runs
        // strictly after the unregister — the latent close-before-unregister
        // race the inline handler had (close fired while the unregister IIFE
        // was still in flight) is gone.
        await controller
          .unregisterSource(
            { type: 'live', stepName: event.stepName },
            { suppressCompletionBanner: true },
          )
          .catch(deps.onSendError)
        await controller
          .emitBanner({ kind: 'error', text: `step ${event.stepName} failed` })
          .catch(deps.onSendError)
      } else {
        await controller
          ?.emitBanner({ kind: 'error', text: `step ${event.stepName} failed` })
          .catch(deps.onSendError)
      }
      tee.close(event.stepName)
      return
    }
    if (event.type === 'step:parallel-start') {
      // Open the `_rollup` meta tee and register a rollup source. The hidden
      // pane tails the tee via `tail -F`; the controller auto-swaps to it when
      // the user is in live mode, or emits an info banner on a replay.
      tee.open(ROLLUP_STEP_NAME)
      const teePath = teePathFor(logger, ROLLUP_STEP_NAME)
      if (teePath !== null && controller !== undefined) {
        await controller
          .registerSource({ type: 'rollup' }, { kind: 'file-tail', path: teePath })
          .catch(deps.onSendError)
      }
      return
    }
    if (event.type === 'step:parallel-branch-update') {
      const snapshot = rollup.apply({
        stepName: event.stepName,
        branchStatus: event.branchStatus,
        ...(event.elapsedMs !== undefined ? { elapsedMs: event.elapsedMs } : {}),
        ...(event.toolCount !== undefined ? { toolCount: event.toolCount } : {}),
      })
      tee.write(ROLLUP_STEP_NAME, renderRollupPayload(snapshot))
      return
    }
    if (event.type === 'step:parallel-complete') {
      // Unregister BEFORE closing the tee (unregister kills the hidden pane, so
      // there's no consumer for trailing bytes) and reset the aggregator so a
      // subsequent parallel block starts with a fresh snapshot.
      if (controller !== undefined) {
        await controller.unregisterSource({ type: 'rollup' }).catch(deps.onSendError)
      }
      tee.close(ROLLUP_STEP_NAME)
      rollup.reset()
      return
    }
    if (
      event.type === 'subworkflow:enter' ||
      event.type === 'subworkflow:exit' ||
      event.type === 'host-error' ||
      // Run-scoped finalization event consumed by the cmux host; the two-pane
      // choreographer renders per-step panes and the end-of-run summary comes
      // from the steps-view projection, so there's nothing to do here.
      event.type === 'run:ended'
    ) {
      return
    }
    const _exhaustive: never = event
    return _exhaustive
  }

  // FIFO tail: chain each event's processing so its effects settle before the
  // next begins. The `.catch` makes the chain unpoisonable — a rejected link
  // would otherwise silently skip every later event.
  let tail: Promise<void> = Promise.resolve()

  const handle = (event: StepLifecycleEvent): Promise<void> => {
    tail = tail.then(() => process(event).catch(deps.onSendError))
    return tail
  }

  const quiescent = (): Promise<void> => tail

  return { handle, quiescent }
}

// Re-exported so the host (and tests) can reference the rollup meta-step key
// without re-deriving it.
export { ROLLUP_STEP_NAME }
