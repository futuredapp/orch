// MIGRATED → tests-new/unit/observability/status-loop-subworkflow.test.ts (parent U13) — relocated verbatim (import paths only); kept skipped on disk (D2).
// U6 — `applyEvent` early-returns on subworkflow boundary events and
// host-error records. The per-step status rollup is not affected by these
// events; the two-pane host consumes them via its own choreographer.

import { describe, expect, it } from 'bun:test'
import { applyEvent } from '../../../src/observability/status-loop.ts'
import type { StepStatusRecord } from '../../../src/observability/status-pane.ts'

// `LiveEntry` is internal to status-loop; mirror its shape here so the test
// stays focused on `applyEvent` behavior without exporting an internal alias.
type LiveEntry = Omit<StepStatusRecord, 'name'>

describe.skip('applyEvent — subworkflow events do not mutate the per-step rollup', () => {
  it('subworkflow:enter does not register a new live entry', () => {
    const live = new Map<string, LiveEntry>()

    applyEvent(live, { type: 'subworkflow:enter', name: 'sub', depth: 1 }, 1000)

    expect(live.size).toBe(0)
  })

  it('subworkflow:exit does not register a new live entry', () => {
    const live = new Map<string, LiveEntry>()

    applyEvent(
      live,
      { type: 'subworkflow:exit', name: 'sub', depth: 1, durationMs: 10, outcome: 'completed' },
      1000,
    )

    expect(live.size).toBe(0)
  })

  it('host-error does not register a new live entry', () => {
    const live = new Map<string, LiveEntry>()

    applyEvent(
      live,
      { type: 'host-error', source: 'subworkflow:exit', name: 'sub', depth: 1, message: 'oops' },
      1000,
    )

    expect(live.size).toBe(0)
  })

  it('does not perturb a pre-existing rollup when a subworkflow event fires', () => {
    const live = new Map<string, LiveEntry>([
      ['plan', { status: 'running', mode: 'autonomous', startedAt: 100 }],
    ])

    applyEvent(live, { type: 'subworkflow:enter', name: 'sub', depth: 1 }, 200)

    expect(live.get('plan')?.status).toBe('running')
    expect(live.size).toBe(1)
  })
})
