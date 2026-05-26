// ---------------------------------------------------------------------------
// step-lifecycle — the single envelope every step's lifecycle flows through.
// ---------------------------------------------------------------------------
//
// Before this module, the `step:start → step:complete | step:failed` trio
// (plus the parallel branch-update supplement and elapsed-time bookkeeping)
// was hand-written at four sites inside `workflow.ts`. Changing the ordering,
// the payload, or the parallel handling meant four synchronised edits, and a
// new step kind had to remember to replicate the pattern by hand — one site
// (agent validation/schema failures) had already drifted, throwing past the
// emitters without ever firing a terminal event.
//
// `withStepLifecycle` concentrates that shape behind one interface: the body
// just "produces the value." Emission order, the parallel supplement, the
// span tee, and the duration source all live here. The trio is tested once,
// against this interface, instead of once per kind.

import type { Host } from '../hosts/index.ts'
import type { JsonObject, StepSpan } from '../observability/index.ts'
import type { Clock } from '../services/index.ts'
import type { StepEntry } from '../state/index.ts'
import { currentParallelDepth } from './execution-context.ts'
import type { StepMode, StepName } from './types.ts'
// Type-only — `workflow.ts` imports `withStepLifecycle` from here at runtime,
// so a value-level import would create a cycle. The event union is erased.
import type { StepLifecycleEvent } from './workflow.ts'

// Step-scoped subset of `StepLifecycleEvent` — every variant that carries a
// `stepName`. The block-scoped events (`step:parallel-start` /
// `step:parallel-complete`) are emitted by `parallel()` directly and never
// reach this module.
type StepScopedLifecycleEvent = Extract<StepLifecycleEvent, { stepName: StepName }>

// ---------------------------------------------------------------------------
// emitStepLifecycle — tee a step-scoped event through the host AND the span.
// Host owns rendering; the span owns the structured trace. A single call site
// keeps the two observers in lock-step.
// ---------------------------------------------------------------------------

function emitStepLifecycle(
  host: Host,
  stepSpan: StepSpan | undefined,
  event: StepScopedLifecycleEvent,
): void {
  host.onLifecycleEvent(event)
  if (stepSpan === undefined) return
  const { type, stepName: _name, ...rest } = event
  // The host receives the live error (an Error keeps its stack for the failure
  // frame); the structured log needs a string — `JSON.stringify(new Error())`
  // is `{}` because `message`/`name` are non-enumerable, which would silently
  // drop the failure reason from `lifecycle.ndjson`.
  const record: JsonObject =
    'error' in rest
      ? { type, ...(rest as JsonObject), error: stringifyError(rest.error) }
      : { type, ...(rest as JsonObject) }
  void stepSpan.append('lifecycle', record).catch(() => {})
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}

// ---------------------------------------------------------------------------
// StepTimer — how a step reports its elapsed time to the envelope.
// ---------------------------------------------------------------------------
//
// The envelope measures wall-clock from its own entry by default. Interactive
// steps `stamp()` the runner-reported session duration instead, so lifecycle
// events report the session — not the envelope's spawn/capture/log overhead.
// A body that never stamps gets wall-clock (autonomous / command / ask).
export interface StepTimer {
  stamp(durationMs: number): void
}

// ---------------------------------------------------------------------------
// StepLifecycleContext — everything the envelope needs to emit the trio.
// ---------------------------------------------------------------------------

export interface StepLifecycleContext {
  readonly host: Host
  readonly stepSpan: StepSpan | undefined
  readonly clock: Clock
  readonly key: StepName
  readonly mode: StepMode
  /**
   * Emit `step:parallel-branch-update` alongside the trio when the step runs
   * inside `parallel()`. `ask` opts out — it throws if it ever finds itself in
   * a parallel scope, so it never produces a branch.
   */
  readonly trackParallel: boolean
}

// What a per-kind executor produces. The envelope adds nothing to it — it just
// brackets the production with lifecycle events.
export interface StepProduct<T> {
  readonly value: T
  readonly entry: StepEntry
}

// ---------------------------------------------------------------------------
// withStepLifecycle — bracket a step's body with its lifecycle events.
// ---------------------------------------------------------------------------
//
// Emits `step:start` (and, when tracked and inside `parallel()`, a `running`
// branch-update), runs `body`, then emits `step:complete` or — if the body
// throws — `step:failed`, each with the matching branch-update. The thrown
// error is both emitted as the `step:failed` payload and rethrown unchanged,
// so the caller's failure classification is untouched.
export async function withStepLifecycle<T>(
  ctx: StepLifecycleContext,
  body: (timer: StepTimer) => Promise<StepProduct<T>>,
): Promise<StepProduct<T>> {
  const { host, stepSpan, key, mode, trackParallel } = ctx
  const startedAt = ctx.clock.now()
  let stamped: number | undefined
  const timer: StepTimer = {
    stamp(durationMs: number): void {
      stamped = durationMs
    },
  }
  const elapsed = (): number => stamped ?? ctx.clock.now() - startedAt
  const inParallel = trackParallel && currentParallelDepth() > 0

  emitStepLifecycle(host, stepSpan, { type: 'step:start', stepName: key, mode })
  if (inParallel) {
    emitStepLifecycle(host, stepSpan, {
      type: 'step:parallel-branch-update',
      stepName: key,
      branchStatus: 'running',
    })
  }

  try {
    const product = await body(timer)
    const durationMs = elapsed()
    emitStepLifecycle(host, stepSpan, { type: 'step:complete', stepName: key, durationMs })
    if (inParallel) {
      emitStepLifecycle(host, stepSpan, {
        type: 'step:parallel-branch-update',
        stepName: key,
        branchStatus: 'completed',
        elapsedMs: durationMs,
      })
    }
    return product
  } catch (err) {
    const durationMs = elapsed()
    emitStepLifecycle(host, stepSpan, { type: 'step:failed', stepName: key, error: err })
    if (inParallel) {
      emitStepLifecycle(host, stepSpan, {
        type: 'step:parallel-branch-update',
        stepName: key,
        branchStatus: 'failed',
        elapsedMs: durationMs,
      })
    }
    throw err
  }
}
