// MIGRATED ← tests/unit/hosts/two-pane/steps-view/subworkflow-collapse.test.tsx (parent U7c)
//
// `model` category, plain render test (not a `scenario()`): a synchronous
// `renderToString(<StepsView>)` over hand-built `StepRow`s — no tmux. This is
// the one genuinely *rendering* subworkflow risk (does the gutter survive at
// depth/width), so the exact compact-token chrome (`│4 `) is the spec asserted
// directly on the rendered frame, the same way `tmux-argv` / `model/controller`
// hold their own literals. The full Ink projection→string path is exercised; a
// `screen` byte twin would only add terminal-grid fidelity to a width-driven
// gutter and is intentionally not authored (renderToString proves the bytes).
//
// AE12 pin: when effective depth >= 4 AND paneCols < 60, the gutter prefix
// collapses from stacked `│ │ │ │ ` to the compact token `│N `. Boundary rows
// for a depth-d sub use the depth-(d-1) compact form. Stacked form at width 80
// and at depth 3 with width 50 are the negative cases AE12 calls out.

import { describe, expect, it } from 'bun:test'
import { renderToString } from 'ink'
import type { StepRow, StepsViewState } from '../../src/hosts/two-pane/steps-view/index.ts'
import { StepsView } from '../../src/hosts/two-pane/steps-view/index.ts'
import { stripAnsi } from '../../src/observability/index.ts'

const NOOP = (): void => {}

function enter(name: string, depth: number, subPath: readonly string[]): StepRow {
  return { kind: 'subworkflow-enter', name, depth, subPath, glyph: '▼' }
}

function liveState(steps: readonly StepRow[]): StepsViewState {
  return {
    status: 'live',
    run: { runId: 'r-2026-06-01-100000-aa', workflowName: 'demo', startedAt: 0 },
    steps,
    view: { mode: 'live' },
  }
}

function chainSteps(): readonly StepRow[] {
  return [
    enter('outer', 1, ['outer']),
    enter('mid1', 2, ['outer', 'mid1']),
    enter('mid2', 3, ['outer', 'mid1', 'mid2']),
    enter('leaf', 4, ['outer', 'mid1', 'mid2', 'leaf']),
    {
      kind: 'agent',
      mode: 'autonomous',
      status: 'completed',
      name: 'plan',
      startedAt: 0,
      endedAt: 1000,
      depth: 4,
    },
  ]
}

function frameAt(steps: readonly StepRow[], paneCols: number): string {
  const originalCols = process.stdout.columns
  Object.defineProperty(process.stdout, 'columns', { value: paneCols, configurable: true })
  try {
    const raw = renderToString(
      <StepsView state={liveState(steps)} onIntent={NOOP} now={() => 5_000} />,
      { columns: paneCols },
    )
    return stripAnsi(raw)
  } finally {
    Object.defineProperty(process.stdout, 'columns', {
      value: originalCols,
      configurable: true,
    })
  }
}

describe('<StepsView> depth-overflow collapse (AE12)', () => {
  it('renders the compact `│4 ` token for depth-4 step rows at pane width 50', () => {
    const frame = frameAt(chainSteps(), 50)
    const planLine = frame.split('\n').find((l) => l.includes('plan'))

    expect(planLine).toContain('│4 ')
  })

  it('renders depth-4 sub boundary rows with the depth-3 compact form (`│3 ▼ leaf`)', () => {
    const frame = frameAt(chainSteps(), 50)
    const leafEnter = frame.split('\n').find((l) => l.includes('▼') && l.includes('leaf'))

    expect(leafEnter).toContain('│3 ')
    expect(leafEnter).toContain('▼')
  })

  it('renders the stacked-bar form at pane width 80 even when depth is 4', () => {
    const frame = frameAt(chainSteps(), 80)
    const planLine = frame.split('\n').find((l) => l.includes('plan'))

    expect(planLine).not.toContain('│4 ')
    // Four stacked `│ ` gutter pairs at depth 4.
    expect(planLine).toMatch(/│ +│ +│ +│ +plan/)
  })

  it('renders the stacked-bar form at depth 3, width 50 (both conditions are required)', () => {
    const depth3Steps: readonly StepRow[] = [
      enter('outer', 1, ['outer']),
      enter('mid1', 2, ['outer', 'mid1']),
      enter('leaf', 3, ['outer', 'mid1', 'leaf']),
      {
        kind: 'agent',
        mode: 'autonomous',
        status: 'completed',
        name: 'plan',
        startedAt: 0,
        endedAt: 1000,
        depth: 3,
      },
    ]
    const frame = frameAt(depth3Steps, 50)
    const planLine = frame.split('\n').find((l) => l.includes('plan'))

    expect(planLine).not.toContain('│3 ')
    expect(planLine).toMatch(/│ +│ +│ +plan/)
  })
})
