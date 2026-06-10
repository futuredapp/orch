// Public barrel — single import surface for the steps-view module.
// Cross-module consumers (TmuxHost, future right-pane-controller) MUST import
// from here, not from internal files. Internal cross-imports between files in
// this directory use relative paths.

export type { ColumnSet } from './adaptive-columns.ts'
export { COLUMN_THRESHOLDS, pickColumns } from './adaptive-columns.ts'
export type { EndOfRunFooterProps, EndOfRunSummaryProps } from './end-of-run-summary.tsx'
export { EndOfRunFooter, EndOfRunSummary } from './end-of-run-summary.tsx'
export type {
  StartStepsViewHandle,
  StartStepsViewOptions,
  StepsIntent,
} from './start-steps-view.ts'
export { STEPS_VIEW_SUBCOMMAND, StepsIntentSchema, startStepsView } from './start-steps-view.ts'
export type { StepsViewIntent, StepsViewKeyEvent, StepsViewProps } from './steps-view.tsx'
export { HelpOverlay, ParallelGroup, StepsView } from './steps-view.tsx'
export type { StepsSelection } from './steps-view-hooks.ts'
export { useAdaptiveColumns, useStepsSelection } from './steps-view-hooks.ts'
export type {
  Banner,
  CreateStepsViewModelOptions,
  LiveOverlay,
  RunHeader,
  StepRow,
  StepStatus,
  StepsViewModel,
  StepsViewState,
  SubworkflowEvent,
  SubworkflowOverlay,
  TuiOverlay,
  TuiOverlaySnapshot,
  ViewMode,
} from './steps-view-model.ts'
export {
  applyLifecycleEvent,
  applySubworkflowEvent,
  createStepsViewModel,
  DEFAULT_TUI_OVERLAY,
  parseTuiOverlayLine,
  projectStepsView,
  serializeTuiOverlayLine,
  subworkflowOverlayKey,
} from './steps-view-model.ts'
// Runner re-entry surface — the CLI dispatcher routes `__steps-view` here when
// the compiled binary re-invokes itself to launch the left pane.
export { parseRunnerArgs, runStepsViewRunner } from './steps-view-runner.tsx'
export type { TailNdjsonHandle, TailNdjsonOptions } from './tail-ndjson.ts'
export { tailNdjson } from './tail-ndjson.ts'
export type { TailStateJsonHandle, TailStateJsonOptions } from './tail-state-json.ts'
export { tailStateJson } from './tail-state-json.ts'
