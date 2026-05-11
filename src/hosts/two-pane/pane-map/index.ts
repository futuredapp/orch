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
export type { CreateScratchSessionDeps, ScratchSessionHandle } from './scratch-session.ts'
export {
  createScratchSession,
  SCRATCH_SESSION_NAME,
  teardownScratchSession,
} from './scratch-session.ts'
