// ---------------------------------------------------------------------------
// pane-map barrel
// ---------------------------------------------------------------------------

export type { PaneSpec, SourceKey } from './pane-spec.ts'
export { sourceKeyToString } from './pane-spec.ts'
export type {
  RightPaneController,
  RightPaneControllerOptions,
} from './right-pane-controller.ts'
export { createRightPaneController } from './right-pane-controller.ts'
export type { CreateSourceSessionOptions, SourceSessionHandle } from './source-session.ts'
export {
  createSourceSession,
  MAX_SESSION_NAME_LENGTH,
  SOURCE_HOLDER_ARGV,
  SOURCE_SESSION_PREFIX,
  sanitizeSessionName,
  teardownSourceSession,
} from './source-session.ts'
