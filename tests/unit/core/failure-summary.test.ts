// Unit tests for the FailureSummary value + summarizeFailure() factory. Both
// host renderers (plain-host, two-pane host) hang off this shape, so its
// fields matter more than the rendered string form.

import { describe, expect, it } from 'bun:test'
import { summarizeFailure } from '../../../src/core/failure-summary.ts'
import { stepName } from '../../../src/core/types.ts'
import type { RunId } from '../../../src/state/index.ts'

const RUN_ID = 'r-2026-04-23-phased2' as RunId
const STEP = stepName('plan')

describe('summarizeFailure', () => {
  it('carries the step name, runId, and failedAt through verbatim', () => {
    const summary = summarizeFailure({
      stepName: STEP,
      runId: RUN_ID,
      error: new Error('boom'),
      failedAt: 1_700_000_000_000,
    })

    expect(summary.stepName).toBe(STEP)
    expect(summary.runId).toBe(RUN_ID)
    expect(summary.failedAt).toBe(1_700_000_000_000)
  })

  it('extracts the Error.message as the summary errorMessage', () => {
    const summary = summarizeFailure({
      stepName: STEP,
      runId: RUN_ID,
      error: new Error('subprocess exited 1'),
      failedAt: 0,
    })

    expect(summary.errorMessage).toBe('subprocess exited 1')
  })

  it('passes through a string error as the errorMessage', () => {
    const summary = summarizeFailure({
      stepName: STEP,
      runId: RUN_ID,
      error: 'exit 137',
      failedAt: 0,
    })

    expect(summary.errorMessage).toBe('exit 137')
    expect(summary.stackTrace).toEqual([])
  })

  it('falls back to JSON.stringify for object errors', () => {
    const summary = summarizeFailure({
      stepName: STEP,
      runId: RUN_ID,
      error: { cause: 'deadline', ms: 5000 },
      failedAt: 0,
    })

    expect(summary.errorMessage).toBe('{"cause":"deadline","ms":5000}')
  })

  it('drops the first line of Error.stack (the duplicate name/message line)', () => {
    const err = new Error('boom')
    // Synthesize a deterministic stack shape so the test is not bound to Bun's
    // internals. The first line is always `<name>: <message>` on V8/Bun.
    err.stack = 'Error: boom\n    at runAgentStep (src/core/workflow.ts:374)\n    at anon (x:1)'

    const summary = summarizeFailure({
      stepName: STEP,
      runId: RUN_ID,
      error: err,
      failedAt: 0,
    })

    expect(summary.stackTrace).toEqual([
      '    at runAgentStep (src/core/workflow.ts:374)',
      '    at anon (x:1)',
    ])
  })

  it('builds the Story 1.5 resume + logs hints from the runId', () => {
    const summary = summarizeFailure({
      stepName: STEP,
      runId: RUN_ID,
      error: new Error('x'),
      failedAt: 0,
    })

    expect(summary.resumeHint).toBe(`orch resume ${RUN_ID}`)
    expect(summary.logsHint).toBe(`orch logs ${RUN_ID}`)
  })

  it('carries downstream step names when supplied', () => {
    const summary = summarizeFailure({
      stepName: STEP,
      runId: RUN_ID,
      error: new Error('x'),
      failedAt: 0,
      downstream: [stepName('build'), stepName('review')],
    })

    expect(summary.downstream).toEqual([stepName('build'), stepName('review')])
  })

  it('defaults downstream to an empty list when omitted', () => {
    const summary = summarizeFailure({
      stepName: STEP,
      runId: RUN_ID,
      error: new Error('x'),
      failedAt: 0,
    })

    expect(summary.downstream).toEqual([])
  })
})
