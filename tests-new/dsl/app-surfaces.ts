// ---------------------------------------------------------------------------
// Typed app surfaces — caught by types, not just at runtime (D11).
// ---------------------------------------------------------------------------
//
// Not every action/assertion is meaningful on every driver, so the surfaces
// differ by driver family. Unsupported actions are a TYPE error, with runtime
// guards as defense-in-depth only. A `model` scenario cannot call `rightPane`;
// a `model+screen` scenario is typed to only the SHARED `leftPane` surface.
// See `scenario.ts` for the `SharedApp` machinery that enforces this.

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
  /** `'mid-step'` pauses with all-but-last completed and the last step running. */
  readonly stopAt?: 'mid-step'
}

export type ModelSpec = LaunchSpec
export type ScreenSpec = LaunchSpec
export type FullHostSpec = LaunchSpec
export type LifecycleSpec = LaunchSpec

/** The minimum every app provides — the registry tears down via this. */
export interface AppBase {
  teardown(): Promise<void>
}

export interface ModelApp extends AppBase {
  launch(spec: ModelSpec): Promise<void>
  /** Projection-seam assertions only. */
  readonly leftPane: LeftPane
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
}

export interface LifecycleApp extends AppBase {
  launch(spec: LifecycleSpec): Promise<void>
  press(pane: 'left' | 'right', key: string): Promise<void>
  signal(sig: Signal): Promise<void>
  readonly leftPane: LeftPane
  readonly rightPane: RightPane
  /** Exit / teardown / persisted status. */
  readonly system: SystemAssertions
}
