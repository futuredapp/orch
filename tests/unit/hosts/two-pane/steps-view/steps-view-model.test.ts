// Fixture-driven tests for `projectStepsView` — the pure projector that fuses
// persisted RunState with the live overlay into a render-ready
// `StepsViewState`.
//
// Tests build synthetic `RunState` values inline (no `FileStateStore` here —
// that's the integration layer's job). The overlay is a plain `Map`.

import { describe, expect, it } from 'bun:test'
import {
  type LiveOverlay,
  projectStepsView,
} from '../../../../../src/hosts/two-pane/steps-view/index.ts'
import { makeRunState, makeStepEntry } from '../../../../helpers/make-step-entry.ts'

const HEADER = { workflowName: 'demo', runIdFallback: 'r-2026-04-10-458000-q8' }

describe('projectStepsView', () => {
  it('returns a live state with no steps when neither persisted state nor overlay exist', () => {
    const state = projectStepsView({
      run: undefined,
      overlay: new Map(),
      ...HEADER,
    })

    expect(state.status).toBe('live')
    expect(state.steps).toHaveLength(0)
    expect(state.run.runId).toBe(HEADER.runIdFallback)
    expect(state.run.workflowName).toBe('demo')
  })

  it('surfaces a running step that exists only in the overlay (not yet persisted)', () => {
    const overlay = new Map<string, LiveOverlay>([
      ['work', { status: 'running', startedAt: 100, mode: 'autonomous' }],
    ])

    const state = projectStepsView({ run: undefined, overlay, ...HEADER })

    expect(state.status).toBe('live')
    expect(state.steps).toHaveLength(1)
    const row = state.steps[0]
    expect(row?.name).toBe('work')
    expect(row?.status).toBe('running')
    expect(row?.kind).toBe('agent')
    if (row?.kind === 'agent') expect(row.mode).toBe('autonomous')
  })

  it('renders a completed agent step persisted in state.json with no live overlay entry', () => {
    const run = makeRunState({
      status: 'running',
      steps: {
        plan: makeStepEntry({ name: 'plan', mode: 'autonomous', startedAt: 100, endedAt: 500 }),
      },
    })

    const state = projectStepsView({ run, overlay: new Map(), ...HEADER })

    expect(state.status).toBe('live')
    expect(state.steps).toHaveLength(1)
    const row = state.steps[0]
    expect(row?.name).toBe('plan')
    expect(row?.status).toBe('completed')
    expect(row?.kind).toBe('agent')
  })

  it('marks a step as failed when the live overlay says so', () => {
    const run = makeRunState({
      steps: { plan: makeStepEntry({ name: 'plan' }) },
    })
    const overlay = new Map<string, LiveOverlay>([
      ['plan', { status: 'failed', startedAt: 100, endedAt: 200 }],
    ])

    const state = projectStepsView({ run, overlay, ...HEADER })

    const row = state.steps[0]
    expect(row?.status).toBe('failed')
  })

  it('routes prefixed names to the correct kind (commit / worktree / ask / command) and bare names to agent', () => {
    const run = makeRunState({
      steps: {
        'commit:c1': makeStepEntry({ name: 'commit:c1' }),
        'worktree:w1': makeStepEntry({ name: 'worktree:w1' }),
        'ask:a1': makeStepEntry({ name: 'ask:a1' }),
        'command:cmd': makeStepEntry({ name: 'command:cmd' }),
        'agent-step': makeStepEntry({ name: 'agent-step', mode: 'autonomous' }),
        'inter-step': makeStepEntry({ name: 'inter-step', mode: 'interactive' }),
      },
    })

    const state = projectStepsView({ run, overlay: new Map(), ...HEADER })
    const byName = Object.fromEntries(state.steps.map((s) => [s.name, s]))

    expect(byName['commit:c1']?.kind).toBe('commit')
    expect(byName['worktree:w1']?.kind).toBe('worktree')
    expect(byName['ask:a1']?.kind).toBe('ask')
    expect(byName['command:cmd']?.kind).toBe('command')
    const agent = byName['agent-step']
    expect(agent?.kind).toBe('agent')
    if (agent?.kind === 'agent') expect(agent.mode).toBe('autonomous')
    const inter = byName['inter-step']
    expect(inter?.kind).toBe('agent')
    if (inter?.kind === 'agent') expect(inter.mode).toBe('interactive')
  })

  it('produces a completed end-of-run summary when every step succeeded', () => {
    const run = makeRunState({
      status: 'completed',
      startedAt: 1000,
      endedAt: 5000,
      steps: {
        plan: makeStepEntry({ name: 'plan', startedAt: 1000, endedAt: 2000 }),
        work: makeStepEntry({ name: 'work', startedAt: 2000, endedAt: 5000 }),
      },
    })

    const state = projectStepsView({ run, overlay: new Map(), ...HEADER })

    expect(state.status).toBe('completed')
    if (state.status === 'completed') {
      expect(state.summary.stepsTotal).toBe(2)
      expect(state.summary.stepsCompleted).toBe(2)
      expect(state.summary.stepsFailed).toBe(0)
      expect(state.summary.durationMs).toBe(4000)
      expect(state.summary.endedAt).toBe(5000)
    }
  })

  it('flips a completed run to failed status when at least one step has live status failed', () => {
    const run = makeRunState({
      status: 'completed',
      startedAt: 0,
      endedAt: 100,
      steps: {
        plan: makeStepEntry({ name: 'plan' }),
        work: makeStepEntry({ name: 'work' }),
      },
    })
    const overlay = new Map<string, LiveOverlay>([['work', { status: 'failed' }]])

    const state = projectStepsView({ run, overlay, ...HEADER })

    expect(state.status).toBe('failed')
    if (state.status === 'failed') {
      expect(state.summary.stepsFailed).toBe(1)
      expect(state.summary.stepsTotal).toBe(2)
    }
  })

  it('reports a crashed run with non-optional summary', () => {
    const run = makeRunState({ status: 'crashed', startedAt: 0, endedAt: 50, steps: {} })

    const state = projectStepsView({ run, overlay: new Map(), ...HEADER })

    expect(state.status).toBe('crashed')
    if (state.status === 'crashed') {
      expect(state.summary.durationMs).toBe(50)
      expect(state.summary.stepsTotal).toBe(0)
    }
  })
})
