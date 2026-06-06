/**
 * Public barrel for the Tier 5 behavioral DSL. Tests under
 * `tests/integration/lifecycle/*.real.test.ts` MUST import from this file
 * only — never from `./internal/*` (the harness engine is private by
 * convention; see `README.md`).
 */

export type { AssertionArg, FilesystemAssertionArg, PaneAssertionArg } from './assertions.ts'
// ─── Assertions ────────────────────────────────────────────────────────────
export {
  assertContractedOutcome,
  assertContractViolatedThroughout,
  assertFilesystem,
  assertGit,
  assertLeftPane,
  assertOrchExits,
  assertPersistedState,
  assertRightPane,
  assertTerminalEscapeStream,
  assertTmuxSession,
} from './assertions.ts'
// ─── Awaits (polling helpers, NOT user actions) ────────────────────────────
export { awaitRunStatus, awaitStepStatus, awaitVisibleStep } from './awaits.ts'
export type { FilesystemMatcher } from './filesystem-matchers.ts'
// ─── Filesystem / git matchers ─────────────────────────────────────────────
export {
  branchExists,
  commitExists,
  fileContains,
  fileExistsAt,
  runArtifactExists,
  worktreeExists,
} from './filesystem-matchers.ts'
export type { HandleSlot } from './internal/current-handle.ts'
// ─── Handle slot (lifecycle driver context isolation) ─────────────────────
export { createHandleSlot, runWithHandleSlot } from './internal/current-handle.ts'
export type { InvariantViolation, ScenarioTag } from './internal/invariants.ts'
export type {
  AgentControl,
  BringToStateRequest,
  OrchHandle,
  RunId,
  Socket,
} from './internal/lifecycle-handle.ts'
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
export type { EmitThenHangScript, HoldUntilReleasedScript, PuppetScript } from './launch.ts'
// ─── Launcher / scripts ────────────────────────────────────────────────────
export {
  emitThenHang,
  holdUntilReleased,
  launchOrchWorkflow,
  puppet,
  resumeOrchWorkflow,
} from './launch.ts'

// ─── Outcome matchers ──────────────────────────────────────────────────────
export {
  exitedNormally,
  noOrphanChildren,
  stepArtifactsIntact,
  terminalRestoredCleanly,
  tmuxIsTornDown,
  withinMs,
} from './outcome-matchers.ts'
export type { PaneInkState, StepRowGlyph } from './pane-matchers.ts'
// ─── Pane matchers ─────────────────────────────────────────────────────────
export {
  containsText,
  doesNotContain,
  hasFooterText,
  hasNoLiveOutput,
  isFocused,
  isPaneDead,
  showsEndOfRunSummary,
  showsErrorBanner,
  showsFailureSummary,
  showsHelpOverlay,
  showsInfoBanner,
  showsInkState,
  showsInteractiveBadge,
  showsRunCount,
  showsStep,
  showsWorkflowHeader,
  stepHasGlyph,
  stepIsHighlighted,
} from './pane-matchers.ts'
export type { UserAction } from './user-actions.ts'
// ─── User actions ──────────────────────────────────────────────────────────
export {
  clickOnPane,
  closeHelp,
  closeOrchStdin,
  openHelp,
  pressEnterOnSelected,
  pressKeyInPane,
  release,
  scrollRightPane,
  selectStep,
  signalOrch,
  snapToLive,
  typeIntoOrchStdin,
  userAction,
  viewStep,
  wait,
} from './user-actions.ts'
// ─── Workflow matchers ─────────────────────────────────────────────────────
export {
  hasExitCode,
  hasExitedBySignal,
  hasRunStatus,
  hasStatus,
  hasStepCompleted,
  hasStepFailed,
  hasStepStatus,
  isRunningStep,
} from './workflow-matchers.ts'
