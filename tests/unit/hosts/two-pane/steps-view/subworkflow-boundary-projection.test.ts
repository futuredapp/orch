// AE8 + AE11 pin: projector emits `subworkflow-enter`/`subworkflow-exit`
// boundary rows derived from `StepEntry.subPath` transitions across persisted
// steps, layered with the live sub overlay for in-flight stepless subs and
// terminal-state synthesis. Pure projector tests — no Ink, no tail. Asserts on
// row sequence and depth so an implementer who fumbles the gutter math or the
// transition-detection loop trips a failing test.

import { describe, expect, it } from 'bun:test'
import type {
  LiveOverlay,
  StepRow,
  SubworkflowOverlay,
} from '../../../../../src/hosts/two-pane/steps-view/index.ts'
import {
  projectStepsView,
  subworkflowOverlayKey,
} from '../../../../../src/hosts/two-pane/steps-view/index.ts'
import { makeRunState, makeStepEntry } from '../../../../helpers/make-step-entry.ts'

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

describe('projectStepsView — subworkflow boundary rows (AE8, AE11)', () => {
  it('emits ▼-sub / children / ✓-sub between parent-A and parent-B (AE8)', () => {
    const run = makeRunState({
      status: 'running',
      steps: {
        'parent-A': makeStepEntry({ name: 'parent-A' }),
        'simple-feature>plan': makeStepEntry({
          name: 'simple-feature>plan',
          subPath: ['simple-feature'],
        }),
        'simple-feature>implement': makeStepEntry({
          name: 'simple-feature>implement',
          subPath: ['simple-feature'],
        }),
        'parent-B': makeStepEntry({ name: 'parent-B' }),
      },
    })
    const subOverlay = new Map<string, SubworkflowOverlay>([
      subEntry(['simple-feature'], {
        status: 'completed',
        depth: 1,
        startedAt: 100,
        endedAt: 900,
        durationMs: 7900,
      }),
    ])

    const state = projectStepsView({ run, overlay: EMPTY_OVERLAY, subOverlay, ...HEADER })

    expect(state.steps.map(rowSummary)).toEqual([
      'parent-A',
      '▼1:simple-feature',
      'simple-feature>plan',
      'simple-feature>implement',
      '✓1:simple-feature',
      'parent-B',
    ])
  })

  it('stacks `│ ` gutter columns additively across nested subs (AE11 mid-flight)', () => {
    const run = makeRunState({
      status: 'running',
      steps: {
        'outer>inner>plan': makeStepEntry({
          name: 'outer>inner>plan',
          subPath: ['outer', 'inner'],
        }),
        'outer>inner>implement': makeStepEntry({
          name: 'outer>inner>implement',
          subPath: ['outer', 'inner'],
        }),
      },
    })
    const subOverlay = new Map<string, SubworkflowOverlay>([
      subEntry(['outer'], { status: 'running', depth: 1, startedAt: 100 }),
      subEntry(['outer', 'inner'], { status: 'running', depth: 2, startedAt: 200 }),
    ])

    const state = projectStepsView({ run, overlay: EMPTY_OVERLAY, subOverlay, ...HEADER })

    expect(state.steps.map(rowSummary)).toEqual([
      '▼1:outer',
      '▼2:inner',
      'outer>inner>plan',
      'outer>inner>implement',
    ])
    const planRow = state.steps[2]
    const implementRow = state.steps[3]
    expect(planRow?.kind).toBe('agent')
    expect(implementRow?.kind).toBe('agent')
    if (planRow?.kind === 'agent') expect(planRow.depth).toBe(2)
    if (implementRow?.kind === 'agent') expect(implementRow.depth).toBe(2)
  })

  it('closes deepest-first when both subs exit (AE11 completion)', () => {
    const run = makeRunState({
      status: 'completed',
      steps: {
        'outer>inner>plan': makeStepEntry({
          name: 'outer>inner>plan',
          subPath: ['outer', 'inner'],
        }),
      },
    })
    const subOverlay = new Map<string, SubworkflowOverlay>([
      subEntry(['outer'], {
        status: 'completed',
        depth: 1,
        startedAt: 100,
        endedAt: 900,
        durationMs: 800,
      }),
      subEntry(['outer', 'inner'], {
        status: 'completed',
        depth: 2,
        startedAt: 200,
        endedAt: 800,
        durationMs: 600,
      }),
    ])

    const state = projectStepsView({ run, overlay: EMPTY_OVERLAY, subOverlay, ...HEADER })

    expect(state.steps.map(rowSummary)).toEqual([
      '▼1:outer',
      '▼2:inner',
      'outer>inner>plan',
      '✓2:inner',
      '✓1:outer',
    ])
  })

  it('renders ▼-row for an in-flight stepless sub at the end of the projected list', () => {
    const run = makeRunState({
      status: 'running',
      steps: {
        'parent-A': makeStepEntry({ name: 'parent-A' }),
      },
    })
    const subOverlay = new Map<string, SubworkflowOverlay>([
      subEntry(['simple-feature'], { status: 'running', depth: 1, startedAt: 1000 }),
    ])

    const state = projectStepsView({ run, overlay: EMPTY_OVERLAY, subOverlay, ...HEADER })

    expect(state.steps.map(rowSummary)).toEqual(['parent-A', '▼1:simple-feature'])
  })

  it('synthesizes ✗ exit rows for any open sub at terminal status', () => {
    const run = makeRunState({
      status: 'failed',
      steps: {
        'parent-A': makeStepEntry({ name: 'parent-A' }),
        'simple-feature>plan': makeStepEntry({
          name: 'simple-feature>plan',
          subPath: ['simple-feature'],
        }),
      },
    })
    // No exit recorded in overlay: the sub was interrupted before exit fired.
    const subOverlay = new Map<string, SubworkflowOverlay>([
      subEntry(['simple-feature'], { status: 'running', depth: 1, startedAt: 100 }),
    ])

    const state = projectStepsView({ run, overlay: EMPTY_OVERLAY, subOverlay, ...HEADER })

    const rows = state.steps
    expect(rows.map(rowSummary)).toEqual([
      'parent-A',
      '▼1:simple-feature',
      'simple-feature>plan',
      '✗1:simple-feature',
    ])
    const exitRow = rows[3]
    if (exitRow?.kind === 'subworkflow-exit') {
      expect(exitRow.durationMs).toBeUndefined()
    }
  })

  it('does not count boundary rows in the end-of-run summary totals', () => {
    const run = makeRunState({
      status: 'completed',
      endedAt: 1_000,
      steps: {
        'parent-A': makeStepEntry({ name: 'parent-A', endedAt: 100 }),
        'simple-feature>plan': makeStepEntry({
          name: 'simple-feature>plan',
          subPath: ['simple-feature'],
          endedAt: 200,
        }),
      },
    })
    const subOverlay = new Map<string, SubworkflowOverlay>([
      subEntry(['simple-feature'], {
        status: 'completed',
        depth: 1,
        startedAt: 150,
        endedAt: 250,
        durationMs: 100,
      }),
    ])

    const state = projectStepsView({ run, overlay: EMPTY_OVERLAY, subOverlay, ...HEADER })

    if (state.status === 'completed') {
      // Two actual steps (parent-A, plan); boundary rows are projector-only.
      expect(state.summary.stepsTotal).toBe(2)
      expect(state.summary.stepsCompleted).toBe(2)
    } else {
      throw new Error(`unexpected status ${state.status}`)
    }
  })

  it('keeps sibling nested subworkflows with the same leaf name separate', () => {
    const run = makeRunState({
      status: 'completed',
      steps: {
        'api>ship>plan': makeStepEntry({
          name: 'api>ship>plan',
          subPath: ['api', 'ship'],
        }),
        'web>ship>plan': makeStepEntry({
          name: 'web>ship>plan',
          subPath: ['web', 'ship'],
        }),
      },
    })
    const subOverlay = new Map<string, SubworkflowOverlay>([
      subEntry(['api'], { status: 'completed', depth: 1, startedAt: 0, endedAt: 10 }),
      subEntry(['api', 'ship'], { status: 'completed', depth: 2, startedAt: 1, endedAt: 9 }),
      subEntry(['web'], { status: 'completed', depth: 1, startedAt: 10, endedAt: 20 }),
      subEntry(['web', 'ship'], { status: 'completed', depth: 2, startedAt: 11, endedAt: 19 }),
    ])

    const state = projectStepsView({ run, overlay: EMPTY_OVERLAY, subOverlay, ...HEADER })

    expect(state.steps.map(rowSummary)).toEqual([
      '▼1:api',
      '▼2:ship',
      'api>ship>plan',
      '✓2:ship',
      '✓1:api',
      '▼1:web',
      '▼2:ship',
      'web>ship>plan',
      '✓2:ship',
      '✓1:web',
    ])
    const shipRows = state.steps.filter(
      (row): row is Extract<StepRow, { kind: 'subworkflow-enter' | 'subworkflow-exit' }> =>
        row.name === 'ship' &&
        (row.kind === 'subworkflow-enter' || row.kind === 'subworkflow-exit'),
    )
    expect(shipRows.map((row) => row.subPath)).toEqual([
      ['api', 'ship'],
      ['api', 'ship'],
      ['web', 'ship'],
      ['web', 'ship'],
    ])
  })

  it('uses live overlay subPath for an in-flight child step before persistence', () => {
    const overlay = new Map<string, LiveOverlay>([
      [
        'simple-feature>plan',
        {
          status: 'running',
          mode: 'autonomous',
          subPath: ['simple-feature'],
          startedAt: 100,
        },
      ],
    ])
    const subOverlay = new Map<string, SubworkflowOverlay>([
      subEntry(['simple-feature'], { status: 'running', depth: 1, startedAt: 90 }),
    ])

    const state = projectStepsView({ run: undefined, overlay, subOverlay, ...HEADER })

    expect(state.steps.map(rowSummary)).toEqual(['▼1:simple-feature', 'simple-feature>plan'])
    const stepRow = state.steps[1]
    if (stepRow?.kind === 'agent') expect(stepRow.depth).toBe(1)
  })
})
