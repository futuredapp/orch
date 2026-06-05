// MIGRATED ← tests/unit/hosts/two-pane/steps-view/subworkflow-parallel-suppression.test.ts (parent U7c)
//   — the THREE pure-projector cases only. The fourth case ("keeps insideParallel
//   on lifecycle records …") runs a real `parallel()` workflow and asserts
//   persisted lifecycle records on disk — execution/persistence, not projection —
//   and is ledgered `demote→integration` (relocated in U10–U13). The old file
//   therefore stays LIVE (reconcile rule 3 forbids a `// MIGRATED →` marker while
//   one case's target does not yet exist).
//
// `model/projector` category: pure `projectStepsView` tests on pure data. AE9 +
// AE13: a sub running inside a `parallel()` branch (directly OR transitively)
// has its boundary rows suppressed and its step rows render flat (depth 0). The
// suppression signal is `entry.insideParallel: true` on the persisted step.

import { describe, expect, it } from 'bun:test'
import type {
  LiveOverlay,
  StepRow,
  SubworkflowOverlay,
} from '../../../src/hosts/two-pane/steps-view/index.ts'
import {
  projectStepsView,
  subworkflowOverlayKey,
} from '../../../src/hosts/two-pane/steps-view/index.ts'
import { makeRunState, makeStepEntry } from './_support.ts'

const HEADER = { workflowName: 'demo', runIdFallback: 'r-2026-06-01-100000-aa' }
const EMPTY_OVERLAY: ReadonlyMap<string, LiveOverlay> = new Map()

function subEntry(subPath: readonly string[], sub: Omit<SubworkflowOverlay, 'subPath'>) {
  return [subworkflowOverlayKey(subPath), { ...sub, subPath }] as const
}

function rowSummary(row: StepRow): string {
  if (row.kind === 'subworkflow-enter') return `▼${row.depth}:${row.name}`
  if (row.kind === 'subworkflow-exit') return `${row.glyph}${row.depth}:${row.name}`
  return row.name
}

describe('projectStepsView — parallel suppression (AE9, AE13)', () => {
  it('suppresses sub boundary rows for sub-of-parallel branches (AE9)', () => {
    // parallel(['T-1','T-2','T-3'], (t) => runWorkflow(<distinct sub per branch>))
    // — three different subs because R20 forbids reuse. Each branch runs the
    // sub's `plan` step with `insideParallel: true` on the StepEntry.
    const run = makeRunState({
      status: 'completed',
      steps: {
        'shipA>plan': makeStepEntry({
          name: 'shipA>plan',
          subPath: ['shipA'],
          insideParallel: true,
        }),
        'shipB>plan': makeStepEntry({
          name: 'shipB>plan',
          subPath: ['shipB'],
          insideParallel: true,
        }),
        'shipC>plan': makeStepEntry({
          name: 'shipC>plan',
          subPath: ['shipC'],
          insideParallel: true,
        }),
      },
    })
    const subOverlay = new Map<string, SubworkflowOverlay>([
      subEntry(['shipA'], {
        status: 'completed',
        depth: 1,
        insideParallel: true,
        startedAt: 0,
        endedAt: 1,
      }),
      subEntry(['shipB'], {
        status: 'completed',
        depth: 1,
        insideParallel: true,
        startedAt: 0,
        endedAt: 1,
      }),
      subEntry(['shipC'], {
        status: 'completed',
        depth: 1,
        insideParallel: true,
        startedAt: 0,
        endedAt: 1,
      }),
    ])

    const state = projectStepsView({ run, overlay: EMPTY_OVERLAY, subOverlay, ...HEADER })

    // No `▼`/`✓` rows; three flat step rows.
    expect(state.steps.map(rowSummary)).toEqual(['shipA>plan', 'shipB>plan', 'shipC>plan'])
    for (const row of state.steps) {
      if (row.kind === 'agent') expect(row.depth).toBeUndefined()
    }
  })

  it('suppresses transitively for sub-of-sub-inside-parallel (AE13)', () => {
    // parallel(..., (t) => runWorkflow(outer, args)) where outer calls
    // runWorkflow(inner, args). Both outer and inner are inside parallel, so
    // BOTH sets of boundary rows are suppressed and `plan` renders flat.
    const run = makeRunState({
      status: 'completed',
      steps: {
        'outer>inner>plan': makeStepEntry({
          name: 'outer>inner>plan',
          subPath: ['outer', 'inner'],
          insideParallel: true,
        }),
      },
    })
    const subOverlay = new Map<string, SubworkflowOverlay>([
      subEntry(['outer'], {
        status: 'completed',
        depth: 1,
        insideParallel: true,
        startedAt: 0,
        endedAt: 1,
      }),
      subEntry(['outer', 'inner'], {
        status: 'completed',
        depth: 2,
        insideParallel: true,
        startedAt: 0,
        endedAt: 1,
      }),
    ])

    const state = projectStepsView({ run, overlay: EMPTY_OVERLAY, subOverlay, ...HEADER })

    expect(state.steps.map(rowSummary)).toEqual(['outer>inner>plan'])
    const planRow = state.steps[0]
    if (planRow?.kind === 'agent') expect(planRow.depth).toBeUndefined()
  })

  it('does NOT suppress sequential subs whose steps run outside any parallel', () => {
    // Negative control: no insideParallel anywhere → boundary rows render
    // normally (the AE8 path again, pinning that suppression is opt-in).
    const run = makeRunState({
      status: 'completed',
      steps: {
        'simple>plan': makeStepEntry({
          name: 'simple>plan',
          subPath: ['simple'],
        }),
      },
    })
    const subOverlay = new Map<string, SubworkflowOverlay>([
      subEntry(['simple'], {
        status: 'completed',
        depth: 1,
        startedAt: 0,
        endedAt: 1,
        durationMs: 1,
      }),
    ])

    const state = projectStepsView({ run, overlay: EMPTY_OVERLAY, subOverlay, ...HEADER })

    expect(state.steps.map(rowSummary)).toEqual(['▼1:simple', 'simple>plan', '✓1:simple'])
  })
})
