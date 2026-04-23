// ---------------------------------------------------------------------------
// hosts — the observability sinks the workflow executor writes through.
// ---------------------------------------------------------------------------
//
// Phase A exports `plain` + the shared port; Phase D adds `two-pane`. A v2
// `single-pane` host will land here when it does. Every cross-module import
// goes through this barrel — see CLAUDE.md rule #7.

export type {
  Host,
  InteractiveResult,
  InteractiveSpawn,
  PaneAttachment,
  PaneRole,
} from './host.ts'
export type { PlainFormat, PlainHostOptions } from './plain/plain-host.ts'
export { createPlainHost } from './plain/plain-host.ts'
export { stripAnsi } from './plain/strip-ansi.ts'
export { renderTranscriptLine } from './plain/transcript-text.ts'
export type { PaneQueue, TmuxHostOptions } from './two-pane/index.ts'
export { createPaneQueue, createTmuxHost } from './two-pane/index.ts'
