// ---------------------------------------------------------------------------
// Host — the observability seam the workflow executor talks to.
// ---------------------------------------------------------------------------
//
// Phase A introduces the port; only `plain` implements it end-to-end. Phase D
// wires `two-pane`. `single-pane` is reserved for v2.
//
// The executor no longer carries `onEvent` / `onStepEvent` callbacks — every
// observability signal travels through `host.onRunnerEvent` /
// `host.onLifecycleEvent`, and interactive steps attach their view through
// `host.attach(...)`. Replacing two parallel callback hooks with one seam
// keeps test mocks honest (one mockable port vs. two) and makes hosts
// swappable at a single place in the composition root.
//
// Phase A's `PlainHost` is a transparent line-prefixer: lifecycle events land
// as `[orch] …` lines, runner events as `[<step>] …` lines, and `--format=json`
// emits NDJSON on stdout instead. Pane hints are ignored under plain — the
// stdout stream is a single sink regardless of which pane a view claims.

import type { RunMode } from '../core/run-mode.ts'
import type { StepName } from '../core/types.ts'
import type { PaneRole } from '../core/view.ts'
import type { StepLifecycleEvent } from '../core/workflow.ts'
import type { RunnerEvent } from '../runners/index.ts'

// v1 panes. `left` == status rollup, `right` == active step's view. The
// canonical definition lives in core/view.ts so workflow and hosts can agree
// without circular imports; re-exported here for back-compat with existing
// Host-consumer imports from `src/hosts/index.ts`.
export type { PaneRole }

/**
 * Handle returned from `host.attach(...)`. Hosts that physically own a pane
 * (tmux) use `detach()` to hand the pane back; plain host's detach is a no-op.
 * Intentionally keeps both the RAII-style method AND `AsyncDisposable` so
 * callers can pick either style — keeps Phase D's `respawn-pane -k` flow
 * simple without breaking the Phase A contract.
 */
export interface PaneAttachment {
  readonly pane: PaneRole
  detach(): Promise<void>
}

export interface Host {
  readonly mode: RunMode
  /** First-run banner; emitted once per invocation by the CLI entry point. */
  writeBanner(line: string): void
  /** Called by the workflow executor for every autonomous-step RunnerEvent. */
  onRunnerEvent(event: RunnerEvent, step: StepName): void
  /** Called by the workflow executor for every StepLifecycleEvent. */
  onLifecycleEvent(event: StepLifecycleEvent): void
  /**
   * Attach a view on a given pane. Phase A only uses this for interactive
   * steps (to signal the host that a step owns the screen); plain ignores
   * the pane and returns a no-op handle. Phase D uses it to respawn tmux
   * panes when interactive steps begin.
   */
  attach(pane: PaneRole): Promise<PaneAttachment>
  teardown(): Promise<void>
}
