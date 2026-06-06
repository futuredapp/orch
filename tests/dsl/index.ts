// ---------------------------------------------------------------------------
// The DSL — single public barrel. Scenario files import ONLY from here.
// ---------------------------------------------------------------------------
//
// Exposes the scenario runner, the typed app surfaces, and the Pane Objects.
// Drivers, the registry, and frame-parsing internals are NOT part of the public
// surface — scenarios never name a driver type or touch a `PaneDriver`.

export type { AgentSpec, CassetteSpec, RealAgentSpec } from './agent-spec.ts'
export { claudeAgent, codexAgent, emits, fromCassette, holdsOpen, live } from './agent-spec.ts'
export type {
  DriverName,
  FullHostApp,
  FullHostSpec,
  LaunchSpec,
  LifecycleApp,
  LifecyclePaneView,
  LifecycleSpec,
  LiveAgentControl,
  ModelApp,
  ModelSpec,
  ScreenApp,
  ScreenSpec,
  Signal,
} from './app-surfaces.ts'
export { LeftPane } from './panes/left-pane.ts'
export type { GlyphName } from './panes/pane-driver.ts'
export { RightPane } from './panes/right-pane.ts'
export { type PersistedStatus, SystemAssertions } from './panes/system-assertions.ts'
export type { ScenarioCase, ScenarioMeta, SharedApp } from './scenario.ts'
export { scenario } from './scenario.ts'
