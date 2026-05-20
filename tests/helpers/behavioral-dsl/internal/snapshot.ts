/**
 * `LifecycleSnapshot` — the single immutable struct every Tier 5 matcher
 * projects over. Captured atomically per assertion by `snapshot(handle, probe)`
 * (implemented in U6). All matcher semantics live here as field shapes; no
 * matcher reaches back through the harness for side-effecting state.
 *
 * Field origins: plan §6.4 / Key Technical Decisions.
 */

import type { PaneId } from '../../../../src/services/tmux/tmux-service.ts'

/**
 * Snapshot-level status of the run as observed from `state.json`. NOT the same
 * as `state-store.ts`'s persisted enum (`'running' | 'completed' | 'crashed'`).
 * The snapshot widens the surface to include the product-shape decision from
 * plan Key Technical Decisions (`'cancelled'` is the §6.5 `pane-q-during-run`
 * contract value) plus `'failed'` for completeness. When a snapshot reads a
 * status the state store does not yet emit, the snapshot reports the literal
 * string it found — the contract evaluator handles unknown values.
 */
export type StateStatus = 'running' | 'completed' | 'cancelled' | 'failed' | 'crashed' | 'unknown'

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'unknown'

export interface OrchExit {
  /** Exit code as reported by `proc.exited` / `wait()`. `null` if killed by signal only. */
  readonly code: number | null
  /** POSIX signal name (`'SIGINT'`, `'SIGTERM'`, …) when the child died via signal; else `null`. */
  readonly signal: NodeJS.Signals | null
}

export interface PaneSnapshot {
  readonly id: PaneId
  /** `pane_dead` flag from `tmux list-panes -F '#{pane_dead}'`. */
  readonly dead: boolean
}

export interface EscapeCounts {
  /** `\x1b[?1049h` enter-alt-screen markers in cumulative stdout. */
  readonly enters: number
  /** `\x1b[?1049l` exit-alt-screen markers. */
  readonly exits: number
}

export interface MouseTrackingCounts {
  /** `\x1b[?1000h` / `\x1b[?1003h` mouse-tracking-on markers. */
  readonly ons: number
  /** `\x1b[?1000l` / `\x1b[?1003l` mouse-tracking-off markers. */
  readonly offs: number
}

export interface OrphanChild {
  readonly pid: number
  readonly ppid: number
  readonly command: string
}

/**
 * Per-step file integrity. Map keys are step names; the value is whether the
 * step's `formatted_output*` file(s) end with `\n` (the integrity invariant —
 * truncation suggests an interrupted write).
 */
export type PerStepFilesIntact = Readonly<Record<string, boolean>>

export interface LifecycleSnapshot {
  // ─── orch process ─────────────────────────────────────────────────────────
  readonly orchAlive: boolean
  readonly orchExit: OrchExit | null

  // ─── tmux reachability ────────────────────────────────────────────────────
  readonly tmuxSessionExists: boolean
  readonly tmuxServerExists: boolean

  // ─── pane geometry ────────────────────────────────────────────────────────
  readonly panesAlive: readonly PaneSnapshot[]
  readonly leftPaneText: string
  readonly rightPaneText: string
  readonly leftPaneFocused: boolean
  readonly rightPaneFocused: boolean

  // ─── workflow state (from state.json) ─────────────────────────────────────
  readonly stateStatus: StateStatus
  readonly stepStatuses: Readonly<Record<string, StepStatus>>
  readonly perStepFilesIntact: PerStepFilesIntact

  // ─── terminal escape balance (from orch's raw stdout) ─────────────────────
  readonly stdoutAltScreen: EscapeCounts
  readonly stdoutMouseTracking: MouseTrackingCounts

  // ─── orphan children sweep ────────────────────────────────────────────────
  readonly orphanChildren: readonly OrphanChild[]

  // ─── temporal stamps (plan U6 snapshot-consistency requirement) ───────────
  /** Wall-clock ms at the moment of capture. From `Clock.nowMs()`. */
  readonly capturedAtMs: number
  /** How long orch had been alive when this snapshot was taken (ms). */
  readonly orchAliveDurationMs: number
}

// ───────────────────────────────────────────────────────────────────────────
// Matcher / projector types — implementations land in U6 / U8.
// ───────────────────────────────────────────────────────────────────────────

export interface MatchResult {
  readonly matched: boolean
  /** Human-readable diagnostic. On failure, names the matcher AND the actual value. */
  readonly message: string
}

/** Pure projector over a `LifecycleSnapshot`. Matchers MUST NOT touch I/O. */
export type Matcher = (snapshot: LifecycleSnapshot) => MatchResult

/**
 * Polling budget used by outcome matchers like `withinMs(ms)` to bound the
 * window over which an assertion will keep capturing snapshots before giving
 * up. Defined here so outcome-matchers and assertions share one shape.
 */
export interface PollingBudget {
  readonly timeoutMs: number
}
