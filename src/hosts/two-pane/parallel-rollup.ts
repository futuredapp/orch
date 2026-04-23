// ---------------------------------------------------------------------------
// parallel-rollup — Story 3 / Moment A compact rollup renderer.
// ---------------------------------------------------------------------------
//
// When two or more steps are running concurrently inside a `parallel(...)`
// call, the right pane switches from per-branch transcripts to a compact
// rollup: one line per branch with status glyph, elapsed time, and (when
// available) tool count. Per-branch transcripts are still available via plain
// mode and `orch logs <runId>` (Phase E).
//
// The aggregator is a tiny state machine driven by `step:parallel-branch-
// update` events. It lives in-memory in the TmuxHost; no persistence.

import type { StepName } from '../../core/types.ts'
import type { ParallelBranchStatus } from '../../core/workflow.ts'

export interface BranchState {
  readonly stepName: StepName
  readonly status: ParallelBranchStatus
  readonly elapsedMs: number
  readonly toolCount: number | undefined
}

export interface RollupAggregator {
  /** Apply a branch-update event. Returns the new snapshot. */
  apply(event: {
    readonly stepName: StepName
    readonly branchStatus: ParallelBranchStatus
    readonly elapsedMs?: number
    readonly toolCount?: number
  }): readonly BranchState[]
  /** Current snapshot in insertion order. */
  snapshot(): readonly BranchState[]
  /** Count of branches currently in `running` status. */
  runningCount(): number
  /** Clear all state — used when teardown happens. */
  reset(): void
}

export function createRollupAggregator(): RollupAggregator {
  const branches = new Map<StepName, BranchState>()

  return {
    apply(event): readonly BranchState[] {
      const existing = branches.get(event.stepName)
      const next: BranchState = {
        stepName: event.stepName,
        status: event.branchStatus,
        elapsedMs: event.elapsedMs ?? existing?.elapsedMs ?? 0,
        toolCount: event.toolCount ?? existing?.toolCount,
      }
      branches.set(event.stepName, next)
      return [...branches.values()]
    },
    snapshot(): readonly BranchState[] {
      return [...branches.values()]
    },
    runningCount(): number {
      let n = 0
      for (const b of branches.values()) {
        if (b.status === 'running') n++
      }
      return n
    },
    reset(): void {
      branches.clear()
    },
  }
}

// ---------------------------------------------------------------------------
// Glyphs — unicode first; ASCII fallback lives with the left pane's renderer
// (statusPane.stepGlyph). The right pane always runs inside a tmux session,
// so unicode is safe.
// ---------------------------------------------------------------------------

const STATUS_GLYPH: Record<ParallelBranchStatus, string> = {
  running: '●',
  completed: '✓',
  failed: '✗',
  cancelled: '·',
}

// ---------------------------------------------------------------------------
// renderRollupLines — pure renderer; tests assert against the line array.
// ---------------------------------------------------------------------------

export function renderRollupLines(branches: readonly BranchState[]): readonly string[] {
  if (branches.length === 0) return ['(no parallel branches)']

  const lines: string[] = ['parallel branches:']
  for (const b of branches) {
    lines.push(formatBranchLine(b))
  }
  return lines
}

export function renderRollupPayload(branches: readonly BranchState[]): string {
  return `${renderRollupLines(branches).join('\r\n')}\r\n`
}

function formatBranchLine(b: BranchState): string {
  const glyph = STATUS_GLYPH[b.status]
  const elapsed = formatElapsed(b.elapsedMs)
  const toolSuffix = b.toolCount !== undefined ? `  tools:${b.toolCount}` : ''
  return `  ${glyph} ${b.stepName}  ${elapsed}${toolSuffix}`
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const secs = Math.round(ms / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const remSecs = secs % 60
  return `${mins}m${remSecs}s`
}
