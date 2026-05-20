/**
 * Public barrel for the Tier 5 behavioral DSL. Tests under
 * `tests/integration/lifecycle/*.real.test.ts` MUST import from this file
 * only — never from `./internal/*` (the harness engine is private by
 * convention; see `README.md`).
 *
 * Surface as of W1 (U1 + U2): all identifiers exist as typed stubs. Calling
 * any of them throws with the U-ID that owns the implementation. Subsequent
 * Ws fill the bodies in.
 */

export type { AssertionArg, PaneAssertionArg } from './assertions.ts'
// ─── Assertions ────────────────────────────────────────────────────────────
export {
  assertContractedOutcome,
  assertContractViolatedThroughout,
  assertLeftPane,
  assertOrchExits,
  assertPersistedState,
  assertRightPane,
  assertTerminalEscapeStream,
  assertTmuxSession,
} from './assertions.ts'
export type { InvariantViolation, ScenarioTag } from './internal/invariants.ts'
export type { BringToStateRequest, OrchHandle, RunId, Socket } from './internal/lifecycle-handle.ts'
// ─── Shared types tests may need at type-position ──────────────────────────
export type {
  EscapeCounts,
  LifecycleSnapshot,
  Matcher,
  MatchResult,
  MouseTrackingCounts,
  OrchExit,
  OrphanChild,
  PaneMatcherFactory,
  PaneSnapshot,
  PollingBudget,
  StateStatus,
  StepStatus,
} from './internal/snapshot.ts'
export type { EmitThenHangScript, HoldUntilReleasedScript } from './launch.ts'
// ─── Launcher / scripts ────────────────────────────────────────────────────
export { emitThenHang, holdUntilReleased, launchOrchWorkflow } from './launch.ts'

// ─── Outcome matchers ──────────────────────────────────────────────────────
export {
  exitedNormally,
  noOrphanChildren,
  stepArtifactsIntact,
  terminalRestoredCleanly,
  tmuxIsTornDown,
  withinMs,
} from './outcome-matchers.ts'
export type { PaneInkState } from './pane-matchers.ts'
// ─── Pane matchers ─────────────────────────────────────────────────────────
export {
  containsText,
  doesNotContain,
  hasFooterText,
  hasNoLiveOutput,
  isFocused,
  isPaneDead,
  showsInkState,
} from './pane-matchers.ts'
export type { UserAction } from './user-actions.ts'
// ─── User actions ──────────────────────────────────────────────────────────
export {
  clickOnPane,
  closeOrchStdin,
  pressKeyInPane,
  release,
  signalOrch,
  typeIntoOrchStdin,
  userAction,
  wait,
} from './user-actions.ts'
// ─── Workflow matchers ─────────────────────────────────────────────────────
export {
  hasExitCode,
  hasExitedBySignal,
  hasStatus,
  hasStepStatus,
  isRunningStep,
} from './workflow-matchers.ts'
