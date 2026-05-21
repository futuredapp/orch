// ---------------------------------------------------------------------------
// hosts — the observability sinks the workflow executor writes through.
// ---------------------------------------------------------------------------
//
// Phase A exports `plain` + the shared port; Phase D adds `two-pane`. A v2
// `single-pane` host will land here when it does. Every cross-module import
// goes through this barrel — see CLAUDE.md rule #7.

export type {
  CommandLine,
  ForegroundShutdownReason,
  Host,
  InteractiveResult,
  InteractiveSpawn,
  PaneAttachment,
  PaneRole,
} from './host.ts'
export { HostCreationError, HostUnavailableError } from './host.ts'
export type {
  HostFactory,
  HostFactoryInputs,
  HostRegistry,
  RegisterBuiltinHostsDeps,
} from './host-registry.ts'
export {
  createHostRegistry,
  HostResolutionError,
  registerBuiltinHosts,
} from './host-registry.ts'
export type { PlainFormat, PlainHostOptions } from './plain/plain-host.ts'
export { createPlainHost } from './plain/plain-host.ts'
export type { RenderOptions } from './plain/render-line.ts'
export { renderTranscriptLine } from './plain/render-line.ts'
export { stripAnsi } from './plain/strip-ansi.ts'
export type { PaneQueue, TmuxHostOptions } from './two-pane/index.ts'
export { createPaneQueue, createTmuxHost } from './two-pane/index.ts'
