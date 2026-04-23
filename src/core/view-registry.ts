// ---------------------------------------------------------------------------
// resolveView — layered resolver for a step's view + pane.
// ---------------------------------------------------------------------------
//
// Precedence (mirrors `resolveRunMode` so the two layering rules stay
// isomorphic): `silent` short-circuit > step override > runner default >
// built-in fallback.
//
// Why short-circuit silent first: the whole point of `silent: true` is to
// skip both rendering and pane allocation — giving it a pane anyway would
// waste a tmux pane slot once Phase D lands and violate the user's declared
// opt-out. `silent + view` is already rejected at `step.define` parse time,
// so reaching resolveView with both set shouldn't happen; the check here is
// defensive.
//
// Why interactive-in-plain raises `ViewResolutionError`: plain mode is a
// single stdout stream. Interactive steps need a TTY; there is no sensible
// rendering on plain. Users with an `onInteractive` handler go through that
// hook *before* view resolution (the executor bypasses view routing entirely
// when a handler is wired), so this error only fires when a step genuinely
// wants a foreground agent under `--mode=plain`.
//
// Why the built-in fallback is `{ kind: 'transcript', pane: 'right' }`:
// matches Phase A's default `PlainHost` shape (everything becomes a
// `[<step>] …` line) and Phase D's default two-pane behavior (right pane
// shows per-step output). Overriding is always one field away.

import type { Runner } from '../runners/types.ts'
import type { RunMode } from './run-mode.ts'
import type { AgentStepConfig } from './step.ts'
import type { StepMode, StepName } from './types.ts'
import {
  isBuiltinViewKind,
  type PaneRole,
  type ViewDefault,
  type ViewKind,
  type ViewResolution,
  ViewResolutionError,
} from './view.ts'

const BUILTIN_VIEW_DEFAULT: ViewDefault = { kind: 'transcript', pane: 'right' }

export interface ResolveViewInputs {
  readonly stepConfig: AgentStepConfig
  readonly runner: Runner
  readonly runMode: RunMode
  readonly stepName: StepName
  readonly stepMode: StepMode
}

export function resolveView(inputs: ResolveViewInputs): ViewResolution {
  if (inputs.stepConfig.silent === true) {
    return { kind: 'silent' }
  }

  const viewKind = effectiveViewKind(inputs)
  const pane = effectivePane(inputs)

  if (viewKind === 'interactive' && inputs.runMode === 'plain') {
    throw new ViewResolutionError(`step "${inputs.stepName}" is interactive; use --mode=two-pane`)
  }

  return { kind: 'attached', viewKind, pane }
}

function effectiveViewKind(inputs: ResolveViewInputs): ViewKind {
  // Interactive steps always render via the interactive view — the runner's
  // `defaultView` targets autonomous runs, so it would point at 'transcript'
  // and mislead the host about how to open the pane.
  if (inputs.stepMode === 'interactive') return 'interactive'

  const stepOverride = inputs.stepConfig.view
  if (stepOverride !== undefined) {
    if (!isBuiltinViewKind(stepOverride)) {
      // Defensive — `step.define` already rejects this at parse time.
      throw new ViewResolutionError(
        `step "${inputs.stepName}" declares unknown view "${stepOverride}"`,
      )
    }
    return stepOverride
  }

  return inputs.runner.defaultView?.kind ?? BUILTIN_VIEW_DEFAULT.kind
}

function effectivePane(inputs: ResolveViewInputs): PaneRole {
  return inputs.stepConfig.pane ?? inputs.runner.defaultView?.pane ?? BUILTIN_VIEW_DEFAULT.pane
}
