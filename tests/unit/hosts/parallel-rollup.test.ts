// MIGRATED → tests-new/unit/hosts/parallel-rollup.test.ts (parent U12) — relocated verbatim (import paths only); kept skipped on disk (D2).
// Unit tests for the compact parallel rollup renderer + aggregator used by
// the tmux host's right pane when a `parallel(...)` step is active.

import { describe, expect, it } from 'bun:test'
import { stepName } from '../../../src/core/types.ts'
import {
  createRollupAggregator,
  renderRollupLines,
} from '../../../src/hosts/two-pane/parallel-rollup.ts'

describe.skip('createRollupAggregator', () => {
  it('starts with no branches and runningCount 0', () => {
    const agg = createRollupAggregator()
    expect(agg.snapshot()).toEqual([])
    expect(agg.runningCount()).toBe(0)
  })

  it('tracks a branch going running → completed and preserves insertion order', () => {
    const agg = createRollupAggregator()
    agg.apply({ stepName: stepName('plan'), branchStatus: 'running' })
    agg.apply({ stepName: stepName('build'), branchStatus: 'running' })

    expect(agg.runningCount()).toBe(2)
    expect(agg.snapshot().map((b) => b.stepName)).toEqual([stepName('plan'), stepName('build')])

    agg.apply({ stepName: stepName('plan'), branchStatus: 'completed', elapsedMs: 1200 })
    const snap = agg.snapshot()
    expect(agg.runningCount()).toBe(1)
    const plan = snap.find((b) => b.stepName === stepName('plan'))
    expect(plan?.status).toBe('completed')
    expect(plan?.elapsedMs).toBe(1200)
  })

  it('carries toolCount through subsequent updates when the later update omits it', () => {
    const agg = createRollupAggregator()
    agg.apply({ stepName: stepName('plan'), branchStatus: 'running', toolCount: 3 })
    agg.apply({ stepName: stepName('plan'), branchStatus: 'completed', elapsedMs: 500 })

    const plan = agg.snapshot()[0]
    expect(plan?.toolCount).toBe(3)
    expect(plan?.status).toBe('completed')
  })

  it('reset() clears all branches', () => {
    const agg = createRollupAggregator()
    agg.apply({ stepName: stepName('plan'), branchStatus: 'running' })
    agg.reset()

    expect(agg.snapshot()).toEqual([])
    expect(agg.runningCount()).toBe(0)
  })
})

describe.skip('renderRollupLines', () => {
  it('renders the "parallel branches:" header + one line per branch', () => {
    const lines = renderRollupLines([
      {
        stepName: stepName('plan'),
        status: 'running',
        elapsedMs: 1200,
        toolCount: undefined,
      },
      {
        stepName: stepName('build'),
        status: 'completed',
        elapsedMs: 800,
        toolCount: 2,
      },
    ])

    expect(lines[0]).toBe('parallel branches:')
    expect(lines[1]).toContain('● plan')
    expect(lines[1]).toContain('1s')
    expect(lines[2]).toContain('✓ build')
    expect(lines[2]).toContain('tools:2')
  })

  it('uses the failure glyph for failed branches and the dot glyph for cancelled', () => {
    const lines = renderRollupLines([
      { stepName: stepName('a'), status: 'failed', elapsedMs: 0, toolCount: undefined },
      { stepName: stepName('b'), status: 'cancelled', elapsedMs: 0, toolCount: undefined },
    ])

    expect(lines[1]).toContain('✗ a')
    expect(lines[2]).toContain('· b')
  })

  it('returns a placeholder line when no branches are tracked', () => {
    expect(renderRollupLines([])).toEqual(['(no parallel branches)'])
  })
})
