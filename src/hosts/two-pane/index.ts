// ---------------------------------------------------------------------------
// two-pane host barrel — tmux-backed `--mode=two-pane` implementation.
// ---------------------------------------------------------------------------

export type {
  CreateScratchSessionDeps,
  PaneSpec,
  RightPaneController,
  RightPaneControllerOptions,
  ScratchSessionHandle,
  SourceKey,
} from './pane-map/index.ts'
export {
  createRightPaneController,
  createScratchSession,
  SCRATCH_SESSION_NAME,
  sourceKeyToString,
  teardownScratchSession,
} from './pane-map/index.ts'
export type { PaneQueue } from './pane-queue.ts'
export { createPaneQueue } from './pane-queue.ts'
export type { InstallStdioCaptureDeps, StdioCapture } from './stdio-capture.ts'
export { installStdioCapture } from './stdio-capture.ts'
export type { TmuxHostOptions } from './tmux-host.ts'
export { createTmuxHost } from './tmux-host.ts'
