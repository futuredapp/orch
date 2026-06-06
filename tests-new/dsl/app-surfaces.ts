// ---------------------------------------------------------------------------
// Typed app surfaces — caught by types, not just at runtime (D11).
// ---------------------------------------------------------------------------
//
// Not every action/assertion is meaningful on every driver, so the surfaces
// differ by driver family. Unsupported actions are a TYPE error, with runtime
// guards as defense-in-depth only. A `model` scenario cannot call `rightPane`;
// a `model+screen` scenario is typed to only the SHARED `leftPane` surface.
// See `scenario.ts` for the `SharedApp` machinery that enforces this.

import type { AgentSpec } from './agent-spec.ts'
import type { LeftPane } from './panes/left-pane.ts'
import type { RightPane } from './panes/right-pane.ts'
import type { SystemAssertions } from './panes/system-assertions.ts'

export type DriverName =
  | 'model'
  | 'screen'
  | 'full-host:fake-agent'
  | 'full-host:recorded-agent'
  | 'full-host:real-agent'
  | 'lifecycle'

/** Process signals the lifecycle driver can deliver. */
export type Signal = 'SIGINT' | 'SIGTERM' | 'SIGHUP'

/**
 * Launch spec shared by every driver in U1. Later phases extend the per-driver
 * spec aliases below (e.g. `agent` for full-host) without touching this base.
 */
export interface LaunchSpec {
  /** Step names, in order. */
  readonly steps: readonly string[]
  /**
   * `'mid-step'` pauses with all-but-last completed and the last step running;
   * `'end-of-run'` reaches a terminal (completed) state with an end-of-run
   * summary (U5b). Omitted ⇔ a fully-live frame.
   */
  readonly stopAt?: 'mid-step' | 'end-of-run'
  /**
   * Terminal outcome when `stopAt: 'end-of-run'` (U5b — summary colours).
   * `'completed'` (default) renders the green summary label; `'failed'`/`'crashed'`
   * the red one with a non-zero failed count. Ignored unless `stopAt: 'end-of-run'`.
   */
  readonly outcome?: 'completed' | 'failed' | 'crashed'
  /**
   * Bound the steps-body viewport to this many rows (U5a — scroll). On `model`
   * it sets the harness pane height; the `screen` twin uses `resize` instead.
   */
  readonly viewportRows?: number
  /**
   * Render an initial banner above the steps grid (U5b — banner paint). The
   * `model` driver also exposes `emitBanner`/`advanceTime` for TTL behaviour;
   * the `screen` paint twin sets the banner here at launch.
   */
  readonly banner?: { readonly kind: 'info' | 'error'; readonly text: string }
}

export type ModelSpec = LaunchSpec
export type ScreenSpec = LaunchSpec

/** Full-host launch spec — adds the agent slot (defaults to an empty `emits()`). */
export interface FullHostSpec extends LaunchSpec {
  readonly agent?: AgentSpec
}

/** Lifecycle launch spec — adds the agent slot (e.g. `holdsOpen()`). */
export interface LifecycleSpec extends LaunchSpec {
  readonly agent?: AgentSpec
}

/**
 * Live-driven agent control, exposed on `FullHostApp.agent` ONLY when the
 * scenario opts in via `liveDriven: true`. Lets a scenario interleave agent
 * output with user actions (parent §9.5). Absent (undefined) on a static build,
 * so a static scenario touching `app.agent.type` is a type error — the parent's
 * "unsupported action = type error" rule (D-P2.3).
 */
export interface LiveAgentControl {
  /** Type-and-send a line as the live step's agent, awaiting its durable ack. */
  type(text: string): Promise<void>
  /** Finish the live step (optional non-zero code for a headless instance). */
  finish(code?: number): Promise<void>
}

/** The minimum every app provides — the registry tears down via this. */
export interface AppBase {
  teardown(): Promise<void>
}

export interface ModelApp extends AppBase {
  launch(spec: ModelSpec): Promise<void>
  /** Projection-seam assertions only. */
  readonly leftPane: LeftPane
  /**
   * Inject a single-slot banner (U5b). Info banners auto-clear on the VIRTUAL
   * clock via `advanceTime`; error banners persist until dismissed.
   */
  emitBanner(level: 'info' | 'error', text: string): Promise<void>
  /**
   * Advance the banner auto-dismiss clock by `ms` (U5b / D-P2). Drives TTL
   * deterministically — a `screen` test must NEVER wait real wall-clock for a
   * TTL, so `ScreenApp` deliberately has no `advanceTime`.
   */
  advanceTime(ms: number): Promise<void>
}

export interface ScreenApp extends AppBase {
  launch(spec: ScreenSpec): Promise<void>
  /** Real-tmux single-pane byte assertions. */
  readonly leftPane: LeftPane
  resize(width: number, height: number): Promise<void>
}

export interface FullHostApp extends AppBase {
  launch(spec: FullHostSpec): Promise<void>
  complete(step: string): Promise<void>
  readonly leftPane: LeftPane
  /** Transcript / two-pane communication. */
  readonly rightPane: RightPane
  /**
   * Live-driven agent control — present only on a `liveDriven` build, undefined
   * otherwise (parent §9.5, D-P2.3). The full mid-stream interleave scenario is
   * deferred to the migration unit that needs it (parent U4/U6); U2 ships the
   * capability + a reachability proof.
   */
  readonly agent?: LiveAgentControl
}

export interface LifecycleApp extends AppBase {
  launch(spec: LifecycleSpec): Promise<void>
  press(pane: 'left' | 'right', key: string): Promise<void>
  signal(sig: Signal): Promise<void>
  /**
   * Close orch's piped stdin (stdin-EOF). A LIFECYCLE-ONLY action — orch v1 has
   * no stdin-EOF handler, so the contract is deliberately weak (see the
   * `close-stdin` scenario). Keeping it off the other app surfaces preserves the
   * "unsupported action = type error" guarantee (D11).
   */
  closeStdin(): Promise<void>
  /**
   * Fire a `quit` intent the way the steps-view daemon would (append to
   * `tui-intents.ndjson`) — the path the `q-during` cell uses because external
   * `send-keys q` is unreliable before Ink claims raw mode. LIFECYCLE-ONLY.
   */
  quitIntent(): Promise<void>
  /** Click on a pane to move focus across the divider. LIFECYCLE-ONLY (real focus). */
  click(pane: 'left' | 'right'): Promise<void>
  readonly leftPane: LeftPane
  readonly rightPane: RightPane
  /** Exit / teardown / persisted status. */
  readonly system: SystemAssertions
}
