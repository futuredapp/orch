// triage: keep — Tier 2 projection coverage for the published keymap.
//
// Each key in the published vocabulary must produce exactly one
// StepsViewIntent payload. Pins:
//   ↑/↓ navigate (no intent),
//   ⏎ on a step → { type: 'enter', stepName },
//   f → { type: 'follow-live' },
//   q → { type: 'quit' },
//   Esc on an error banner → { type: 'dismiss-banner' },
//   ? toggles help (no intent fired).
//
// A regression here would silently break user navigation (no error,
// just no effect).

import { describe, expect, it } from 'bun:test'
import { render } from 'ink-testing-library'
import type {
  StepsViewIntent,
  StepsViewState,
} from '../../../../../src/hosts/two-pane/steps-view/index.ts'
import { StepsView } from '../../../../../src/hosts/two-pane/steps-view/index.ts'

const ARROW_UP = '\x1b[A'
const ARROW_DOWN = '\x1b[B'
const ESC = '\x1b'

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 30))
}

function baseState(opts?: { banner?: StepsViewState['banner'] }): StepsViewState {
  const state: StepsViewState = {
    status: 'live',
    run: { runId: 'r-2026-05-12-100000-aa', workflowName: 'demo', startedAt: 0 },
    steps: [
      {
        kind: 'agent',
        mode: 'autonomous',
        status: 'completed',
        name: 'plan',
        startedAt: 0,
        endedAt: 1_000,
      },
      {
        kind: 'agent',
        mode: 'autonomous',
        status: 'running',
        name: 'work',
        startedAt: 2_000,
      },
    ],
    view: { mode: 'live' },
    ...(opts?.banner !== undefined ? { banner: opts.banner } : {}),
  }
  return state
}

describe('<StepsView> key → intent mapping', () => {
  it('⏎ on the selected step fires { type: enter, stepName }', async () => {
    const intents: StepsViewIntent[] = []
    const ui = render(
      <StepsView state={baseState()} onIntent={(i) => intents.push(i)} now={() => 5_000} />,
    )
    await tick()

    ui.stdin.write('\r')
    await tick()

    expect(intents).toHaveLength(1)
    expect(intents[0]).toEqual({ type: 'enter', stepName: 'work' })
    ui.unmount()
  })

  it('f fires { type: follow-live } exactly once', async () => {
    const intents: StepsViewIntent[] = []
    const ui = render(
      <StepsView state={baseState()} onIntent={(i) => intents.push(i)} now={() => 5_000} />,
    )
    await tick()

    ui.stdin.write('f')
    await tick()

    expect(intents).toEqual([{ type: 'follow-live' }])
    ui.unmount()
  })

  it('q fires { type: quit }', async () => {
    const intents: StepsViewIntent[] = []
    const ui = render(
      <StepsView state={baseState()} onIntent={(i) => intents.push(i)} now={() => 5_000} />,
    )
    await tick()

    ui.stdin.write('q')
    await tick()

    expect(intents).toEqual([{ type: 'quit' }])
    ui.unmount()
  })

  it('Esc on an error banner fires { type: dismiss-banner }', async () => {
    const intents: StepsViewIntent[] = []
    const state = baseState({
      banner: { kind: 'error', text: 'step plan failed', seq: 1 },
    })
    const ui = render(
      <StepsView state={state} onIntent={(i) => intents.push(i)} now={() => 5_000} />,
    )
    await tick()

    ui.stdin.write(ESC)
    await tick()

    expect(intents).toEqual([{ type: 'dismiss-banner' }])
    ui.unmount()
  })

  it('Esc on no banner fires no intent', async () => {
    const intents: StepsViewIntent[] = []
    const ui = render(
      <StepsView state={baseState()} onIntent={(i) => intents.push(i)} now={() => 5_000} />,
    )
    await tick()

    ui.stdin.write(ESC)
    await tick()

    expect(intents).toEqual([])
    ui.unmount()
  })

  it('↑/↓ does not fire any intent — selection is local state', async () => {
    const intents: StepsViewIntent[] = []
    const ui = render(
      <StepsView state={baseState()} onIntent={(i) => intents.push(i)} now={() => 5_000} />,
    )
    await tick()

    ui.stdin.write(ARROW_UP)
    await tick()
    ui.stdin.write(ARROW_DOWN)
    await tick()

    expect(intents).toEqual([])
    ui.unmount()
  })

  it('? opens help and does not fire any intent', async () => {
    const intents: StepsViewIntent[] = []
    const ui = render(
      <StepsView state={baseState()} onIntent={(i) => intents.push(i)} now={() => 5_000} />,
    )
    await tick()

    ui.stdin.write('?')
    await tick()

    expect(intents).toEqual([])
    // Help overlay is visible in the frame.
    expect(ui.lastFrame()).toContain('Footer indicator')
    ui.unmount()
  })
})
