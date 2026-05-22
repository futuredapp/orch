// ---------------------------------------------------------------------------
// two-pane host barrel — tmux-backed `--mode=two-pane` implementation.
// ---------------------------------------------------------------------------

export type {
  CreateSourceSessionOptions,
  PaneSpec,
  RightPaneController,
  RightPaneControllerOptions,
  SourceKey,
  SourceSessionHandle,
} from './pane-map/index.ts'
export {
  createRightPaneController,
  createSourceSession,
  MAX_SESSION_NAME_LENGTH,
  SOURCE_HOLDER_ARGV,
  SOURCE_SESSION_PREFIX,
  sanitizeSessionName,
  sourceKeyToString,
  teardownSourceSession,
} from './pane-map/index.ts'
export type { PaneQueue } from './pane-queue.ts'
export { createPaneQueue } from './pane-queue.ts'
export type { InstallStdioCaptureDeps, StdioCapture } from './stdio-capture.ts'
export { installStdioCapture } from './stdio-capture.ts'
export type { TmuxHostOptions } from './tmux-host.ts'
export { createTmuxHost, isSessionLostError, TMUX_SESSION_LOST_PATTERN } from './tmux-host.ts'
