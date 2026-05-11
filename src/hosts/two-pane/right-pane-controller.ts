// ---------------------------------------------------------------------------
// right-pane-controller — backward-compat re-export shim.
// ---------------------------------------------------------------------------
//
// The controller body moved to `./pane-map/right-pane-controller.ts` as part
// of the pane-map plan (U3). This file keeps existing imports working while
// later units (U5–U8) migrate callers to the pane-map barrel directly.
// Removed in U10 once all callers have been migrated.

export type {
  RightPaneController,
  RightPaneControllerOptions,
} from './pane-map/right-pane-controller.ts'
export { createRightPaneController } from './pane-map/right-pane-controller.ts'
