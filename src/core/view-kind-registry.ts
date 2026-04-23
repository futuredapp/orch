// ---------------------------------------------------------------------------
// ViewKindRegistry — factory table for StepView implementations.
// ---------------------------------------------------------------------------
//
// The layered `resolveView` (view-registry.ts) decides *which kind* a step
// gets; this registry decides *how to build* a `StepView` instance for that
// kind. Phase E lands the table with only built-ins populated; Phase D's
// hosts still consume events via `host.onRunnerEvent` / `host.onLifecycleEvent`
// directly, so the factories are placeholders that a v2 refactor can swap
// without changing callers.
//
// No import-time side effects (CLAUDE.md rule #8). Built-in registration
// happens in the composition root via `registerBuiltinViews(registry)`.

import type { Host } from '../hosts/host.ts'
import type { StepName } from './types.ts'
import { type PaneRole, type StepView, type ViewKind, ViewResolutionError } from './view.ts'

/** Shape of the input a StepView factory receives to instantiate a view. */
export interface StepViewFactoryInputs {
  readonly host: Host
  readonly pane: PaneRole
  readonly stepName: StepName
}

export type StepViewFactory = (inputs: StepViewFactoryInputs) => StepView

export interface ViewKindRegistry {
  register(kind: ViewKind, factory: StepViewFactory): void
  resolve(kind: ViewKind): StepViewFactory
  list(): readonly ViewKind[]
}

export function createViewKindRegistry(): ViewKindRegistry {
  const table = new Map<ViewKind, StepViewFactory>()
  return {
    register(kind, factory) {
      if (table.has(kind)) {
        throw new ViewResolutionError(`view kind "${kind}" is already registered`)
      }
      table.set(kind, factory)
    },
    resolve(kind) {
      const factory = table.get(kind)
      if (factory === undefined) {
        throw new ViewResolutionError(`unknown view kind "${kind}"`)
      }
      return factory
    },
    list() {
      return [...table.keys()]
    },
  }
}

/**
 * Populates the registry with `transcript` and `interactive` built-ins. The
 * executor doesn't instantiate views in v1 — hosts consume events directly —
 * so the factories return no-op StepViews. When Phase D's host pipelines
 * start routing events through StepView, swap the placeholders in one spot.
 */
export function registerBuiltinViews(registry: ViewKindRegistry): void {
  registry.register('transcript', () => noopStepView('transcript'))
  registry.register('interactive', () => noopStepView('interactive'))
}

function noopStepView(kind: ViewKind): StepView {
  return {
    kind,
    onRunnerEvent() {},
    onLifecycleEvent() {},
    close() {},
  }
}
