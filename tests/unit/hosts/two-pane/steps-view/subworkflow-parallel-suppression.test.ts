// AE9 + AE13 pin: when a sub runs inside a `parallel()` branch — directly OR
// transitively via further-nested subs — the projector suppresses the sub's
// boundary rows uniformly across the subtree, and the contained step rows
// render flat (depth 0). The suppression signal is `entry.insideParallel: true`
// on the persisted step, populated by `runStepOnce` from the ALS branchStore.
// Pure projector tests — no Ink, no `lifecycle.ndjson` re-read.

import { describe, expect, it } from 'bun:test'
import { parallel } from '../../../../../src/core/parallel.ts'
import { runWorkflow } from '../../../../../src/core/run-workflow.ts'
import type { WorkflowDeps } from '../../../../../src/core/workflow.ts'
import { workflow } from '../../../../../src/core/workflow.ts'
import type {
  LiveOverlay,
  StepRow,
  SubworkflowOverlay,
} from '../../../../../src/hosts/two-pane/steps-view/index.ts'
import {
  projectStepsView,
  subworkflowOverlayKey,
} from '../../../../../src/hosts/two-pane/steps-view/index.ts'
import {
  createNullSessionLogger,
  type JsonObject,
  type LogCategory,
  type SessionLogger,
} from '../../../../../src/observability/index.ts'
import {
  FakeClock,
  FakeFsService,
  FakeGitService,
  FakeProcessService,
  path,
} from '../../../../../src/services/index.ts'
import { FakePromptService } from '../../../../../src/services/prompt/index.ts'
import { FileStateStore, type RunId } from '../../../../../src/state/index.ts'
import { createFakeHost } from '../../../../helpers/fake-host.ts'
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

function makeRecordingLogger(runId: RunId): {
  readonly logger: SessionLogger
  readonly records: Array<{ readonly category: LogCategory; readonly record: JsonObject }>
} {
  const base = createNullSessionLogger({ runId })
  const records: Array<{ readonly category: LogCategory; readonly record: JsonObject }> = []
  return {
    records,
    logger: {
      ...base,
      append(category, record) {
        records.push({ category, record })
        return base.append(category, record)
      },
    },
  }
}

function makeWorkflowDeps(runId: RunId, logger: SessionLogger): WorkflowDeps {
  const fs = new FakeFsService()
  return {
    fsService: fs,
    gitService: new FakeGitService(),
    processService: new FakeProcessService(),
    clock: new FakeClock(1000),
    stateStore: new FileStateStore({ fs, basePath: path('/runs') }),
    runId,
    cwd: path('/workspace'),
    host: createFakeHost(),
    logger,
    promptService: new FakePromptService(),
    interactivity: 'interactive',
  }
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
    // normally (this is the AE8 path again, but it pins that the suppression
    // logic is opt-in, not the default).
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

  it('keeps insideParallel on lifecycle records for suppressed homogeneous sub boundaries', async () => {
    const runId = 'r-2026-06-01-100000-lg' as RunId
    const { logger, records } = makeRecordingLogger(runId)
    const deps = makeWorkflowDeps(runId, logger)

    const shipA = workflow('ship-a', async () => {})
    const shipB = workflow('ship-b', async () => {})
    const parent = workflow('parent', async () => {
      await parallel([{ sub: shipA }, { sub: shipB }], async (branch) => {
        await runWorkflow(branch.sub, {})
      })
    })

    await parent.execute(deps)

    const subEvents = records
      .filter((record) => record.category === 'lifecycle')
      .map((record) => record.record)
      .filter((record) => record.type === 'subworkflow:enter' || record.type === 'subworkflow:exit')

    expect(subEvents).toHaveLength(4)
    expect(subEvents.every((record) => record.insideParallel === true)).toBe(true)
    expect(subEvents.map((record) => record.name).sort()).toEqual([
      'ship-a',
      'ship-a',
      'ship-b',
      'ship-b',
    ])
  })
})
