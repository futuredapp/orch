// Category-A demote (parent U13, PD5) — extracted verbatim from the MIXED file
// tests/unit/hosts/two-pane/steps-view/subworkflow-parallel-suppression.test.ts.
// Only the real-`parallel()` persisted-records case demotes to a plain
// `integration` test here (execution/persistence — "passes if the pane is
// empty"). The three `projectStepsView` projection cases are group-B render and
// stay LIVE in the old file (D15). See ledger.

import { describe, expect, it } from 'bun:test'
import { parallel } from '../../../../src/core/parallel.ts'
import { runWorkflow } from '../../../../src/core/run-workflow.ts'
import type { WorkflowDeps } from '../../../../src/core/workflow.ts'
import { workflow } from '../../../../src/core/workflow.ts'
import {
  createNullSessionLogger,
  type JsonObject,
  type LogCategory,
  type SessionLogger,
} from '../../../../src/observability/index.ts'
import {
  FakeClock,
  FakeFsService,
  FakeGitService,
  FakeProcessService,
  path,
} from '../../../../src/services/index.ts'
import { FakePromptService } from '../../../../src/services/prompt/index.ts'
import { FileStateStore, type RunId } from '../../../../src/state/index.ts'
import { createFakeHost } from '@orch/test/fake-host.ts'

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

describe('parallel suppression — persisted lifecycle records', () => {
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
