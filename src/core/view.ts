// ---------------------------------------------------------------------------
// View — what a step declares it wants rendered while it runs.
// ---------------------------------------------------------------------------
//
// A step opts into one of two rendering shapes (`transcript` | `interactive`)
// or out entirely (`silent: true`). Runners ship a `defaultView` so authors
// never have to repeat themselves; step-level `view` / `pane` overrides win.
//
// Phase B lands the seam as *metadata* + a resolver. Phase D wires concrete
// StepView implementations against the Host port; keeping the interface here
// means Phase D is additive, not a type refactor.
//
// `ViewKindRegistry` uses the interface-augmentation pattern so v2 plugins can
// widen the open union without editing core — same pattern Fastify / Pinia /
// Prisma ship. The closed literal `('interactive'|'transcript')` would force
// every future view-kind plugin to patch this file.
//
// `PaneRole` lives here (not `hosts/`) because both `core/view.ts` and
// `hosts/host.ts` need it; pushing it into core keeps hosts as leaf importers.

import type { RunMode } from './run-mode.ts'
import type { StepName } from './types.ts'

// ---------------------------------------------------------------------------
// PaneRole — v1 wires exactly two slots; anything else widens the type.
// ---------------------------------------------------------------------------

export const PANE_ROLES = ['left', 'right'] as const
export type PaneRole = (typeof PANE_ROLES)[number]

export function isPaneRole(value: string): value is PaneRole {
  return (PANE_ROLES as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------
// ViewKind — open union; augment ViewKindRegistry from a plugin to widen.
// ---------------------------------------------------------------------------

export interface ViewKindRegistry {
  readonly interactive: true
  readonly transcript: true
}

export type ViewKind = keyof ViewKindRegistry

// Keep this array in sync with the built-in keys of `ViewKindRegistry`. The
// satisfies-compat guard below traps drift at compile time — if v2 plugins
// widen the registry via `declare module`, they bring their own runtime list.
export const BUILTIN_VIEW_KINDS = ['interactive', 'transcript'] as const
type _BuiltinKindsCoverRegistry =
  // fail the build if a built-in kind leaves the registry list
  (typeof BUILTIN_VIEW_KINDS)[number] extends ViewKind ? true : never
const _builtinKindsCoverRegistry: _BuiltinKindsCoverRegistry = true
void _builtinKindsCoverRegistry

export function isBuiltinViewKind(value: string): value is ViewKind {
  return (BUILTIN_VIEW_KINDS as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------
// ViewDefault — the shape runners expose via `defaultView` and steps carry
// when they override. Small struct — no class, no brand.
// ---------------------------------------------------------------------------

export interface ViewDefault {
  readonly kind: ViewKind
  readonly pane: PaneRole
}

// ---------------------------------------------------------------------------
// StepView — the seam Phase D hosts implement. Intentionally small:
// `onRunnerEvent` and `onLifecycleEvent` split keeps views from narrowing a
// `RunnerEvent | StepLifecycleEvent` union at every call site. `close()` lets
// views release resources (e.g. a tmux buffer id) when the step ends.
//
// Not yet consumed in Phase B — the workflow executor still routes events
// through `host.onRunnerEvent`/`host.onLifecycleEvent`. Phase D introduces
// the view registry and starts handing live StepView instances around.
// ---------------------------------------------------------------------------

import type { RunnerEvent } from '../runners/types.ts'
import type { StepLifecycleEvent } from './workflow.ts'

export interface StepView {
  readonly kind: ViewKind
  onRunnerEvent(event: RunnerEvent): void
  onLifecycleEvent(event: StepLifecycleEvent): void
  close(): void
}

// ---------------------------------------------------------------------------
// ViewResolution — tagged union. "silent" short-circuits every render path;
// "attached" carries the resolved kind + pane so the executor can pick the
// right Phase D StepView from the registry without re-running layering.
// ---------------------------------------------------------------------------

export type ViewResolution =
  | { readonly kind: 'silent' }
  | { readonly kind: 'attached'; readonly viewKind: ViewKind; readonly pane: PaneRole }

// ---------------------------------------------------------------------------
// Errors — consistent `code` field across the core error family.
// ---------------------------------------------------------------------------

export class ViewResolutionError extends Error {
  readonly code = 'VIEW_RESOLUTION_ERROR' as const
  constructor(message: string) {
    super(message)
    this.name = 'ViewResolutionError'
  }
}

export class ViewUnsupportedInModeError extends Error {
  readonly code = 'VIEW_UNSUPPORTED_IN_MODE' as const
  constructor(
    readonly stepName: StepName,
    readonly runMode: RunMode,
    readonly viewKind: ViewKind,
  ) {
    super(
      `step "${stepName}" declares view "${viewKind}" which is not yet wired in --mode=${runMode} (pending Phase D)`,
    )
    this.name = 'ViewUnsupportedInModeError'
  }
}
