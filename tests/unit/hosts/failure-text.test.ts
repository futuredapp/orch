// MIGRATED → tests-new/unit/hosts/failure-text.test.ts (parent U12) — relocated verbatim (import paths only); kept skipped on disk (D2).
// Unit tests for renderFailureText — the pure string producer used by the
// plain host's stderr failure frame.

import { describe, expect, it } from 'bun:test'
import { summarizeFailure } from '../../../src/core/failure-summary.ts'
import { stepName } from '../../../src/core/types.ts'
import { renderFailureText } from '../../../src/hosts/plain/failure-text.ts'
import type { RunId } from '../../../src/state/index.ts'

const RUN = 'r-2026-04-23-phased2' as RunId
const STEP = stepName('build')

describe.skip('renderFailureText', () => {
  it('leads with the failed step headline and error message', () => {
    const text = renderFailureText(
      summarizeFailure({
        stepName: STEP,
        runId: RUN,
        error: new Error('something broke'),
        failedAt: 0,
      }),
    )

    expect(text).toContain('✗ step "build" failed')
    expect(text).toContain('  something broke')
  })

  it('includes the stack trace when the error is an Error with a stack', () => {
    const err = new Error('x')
    err.stack = 'Error: x\n    at runAgentStep (src/core/workflow.ts:374)'

    const text = renderFailureText(
      summarizeFailure({ stepName: STEP, runId: RUN, error: err, failedAt: 0 }),
    )

    expect(text).toContain('    at runAgentStep (src/core/workflow.ts:374)')
  })

  it('omits the stack block for string errors', () => {
    const text = renderFailureText(
      summarizeFailure({ stepName: STEP, runId: RUN, error: 'exit 1', failedAt: 0 }),
    )

    expect(text).not.toMatch(/^\s{4}at /m)
  })

  it('lists downstream steps when present', () => {
    const text = renderFailureText(
      summarizeFailure({
        stepName: STEP,
        runId: RUN,
        error: new Error('x'),
        failedAt: 0,
        downstream: [stepName('review'), stepName('ship')],
      }),
    )

    expect(text).toContain('skipped downstream: review, ship')
  })

  it('ends with the resume + logs hints using the provided runId', () => {
    const text = renderFailureText(
      summarizeFailure({ stepName: STEP, runId: RUN, error: new Error('x'), failedAt: 0 }),
    )

    expect(text).toContain(`resume:  orch resume ${RUN}`)
    expect(text).toContain(`logs:    orch logs ${RUN}`)
  })
})
