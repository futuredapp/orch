// Public barrel for the real-tmux test harness.
//
// Tests import from this module only. Internal files (`fixture.ts`,
// `socket.ts`, …) are private and the path-style import would bypass the
// "single public barrel per module" rule from CLAUDE.md.

export { stripAnsi } from './ansi.ts'
export {
  type CreateRealTmuxFixtureOptions,
  canRunRealTmux,
  canRunRealTmuxE2E,
  createRealTmuxFixture,
  REAL_TMUX_ASSERT_TIMEOUT_MS,
  REAL_TMUX_TEST_TIMEOUT_MS,
  type RealTmuxFixture,
} from './fixture.ts'
export { isNamedKey, type NamedKey, sendKeysToPane } from './keys.ts'
export {
  type CreatePaneHandleDeps,
  createPaneHandle,
  type PaneHandle,
  type WaitOptions,
} from './pane-handle.ts'
export { allocateSocketName, assertNoNestedTmux } from './socket.ts'
export {
  type HarnessStep,
  type MountedHarness,
  type MountTmuxHostOptions,
  mountTmuxHost,
  type RunWorkflowResult,
} from './workflow-driver.ts'
