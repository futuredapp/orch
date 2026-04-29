import { describe, expect, it } from 'bun:test'
import {
  formatElapsed,
  renderStatusPane,
  type StepStatusRecord,
  stepGlyph,
  stripAnsi,
  toStatusRecords,
} from '../../../src/observability/status-pane.ts'
import type { RunId, RunState } from '../../../src/state/index.ts'
import { makeStepEntry } from '../../helpers/make-step-entry.ts'

const NOW = 10_000

function record(
  overrides: Partial<StepStatusRecord> & { readonly name: string },
): StepStatusRecord {
  return {
    status: 'running',
    ...overrides,
  } satisfies StepStatusRecord
}

// ---------------------------------------------------------------------------
// Glyphs
// ---------------------------------------------------------------------------

describe('stepGlyph', () => {
  it('uses Unicode glyphs for every step status when tty is true', () => {
    expect(stepGlyph('pending', true)).toBe('○')
    expect(stepGlyph('running', true)).toBe('●')
    expect(stepGlyph('interactive', true)).toBe('⟳')
    expect(stepGlyph('completed', true)).toBe('✓')
    expect(stepGlyph('failed', true)).toBe('✗')
    expect(stepGlyph('cached', true)).toBe('↺')
  })

  it('falls back to ASCII glyphs when tty is false', () => {
    expect(stepGlyph('pending', false)).toBe('o')
    expect(stepGlyph('running', false)).toBe('*')
    expect(stepGlyph('interactive', false)).toBe('~')
    expect(stepGlyph('completed', false)).toBe('+')
    expect(stepGlyph('failed', false)).toBe('x')
    expect(stepGlyph('cached', false)).toBe('.')
  })
})

// ---------------------------------------------------------------------------
// Elapsed formatting
// ---------------------------------------------------------------------------

describe('formatElapsed', () => {
  it('formats sub-second durations in milliseconds', () => {
    expect(formatElapsed(0)).toBe('0ms')
    expect(formatElapsed(999)).toBe('999ms')
  })

  it('formats second-and-minute durations with rounded seconds', () => {
    expect(formatElapsed(1000)).toBe('1s')
    expect(formatElapsed(59_400)).toBe('59s')
    expect(formatElapsed(60_000)).toBe('1m0s')
    expect(formatElapsed(125_000)).toBe('2m5s')
  })

  it('treats negative inputs as zero instead of throwing', () => {
    expect(formatElapsed(-50)).toBe('0ms')
  })
})

// ---------------------------------------------------------------------------
// ANSI stripping
// ---------------------------------------------------------------------------

describe('stripAnsi', () => {
  it('removes color escapes from a rendered step name', () => {
    const coloured = '\u001b[31mbrainstorm\u001b[0m'
    expect(stripAnsi(coloured)).toBe('brainstorm')
  })

  it('removes cursor-motion escapes injected via untrusted prompts', () => {
    const nasty = 'plan\u001b[2Aoverwrite'
    expect(stripAnsi(nasty)).toBe('planoverwrite')
  })

  it('strips OSC sequences and leaves plain ascii untouched', () => {
    expect(stripAnsi('hello')).toBe('hello')
    expect(stripAnsi('\u001b]0;title\u0007plan')).toBe('plan')
  })
})

// ---------------------------------------------------------------------------
// toStatusRecords — composing persisted state + live tracker
// ---------------------------------------------------------------------------

function runState(overrides: Partial<RunState> = {}): RunState {
  return {
    schemaVersion: 5,
    id: 'r-2026-04-14-458000-q8' as RunId,
    status: 'running',
    startedAt: 0,
    steps: {},
    ...overrides,
  }
}

describe('toStatusRecords', () => {
  it('returns an empty list when neither persisted state nor live records exist', () => {
    expect(toStatusRecords({})).toEqual([])
  })

  it('marks persisted steps as completed with their recorded mode and timestamps', () => {
    const state = runState({
      steps: {
        brainstorm: makeStepEntry({
          name: 'brainstorm',
          startedAt: 1000,
          endedAt: 1500,
          mode: 'interactive',
        }),
      },
    })
    const records = toStatusRecords({ state })
    expect(records).toEqual([
      {
        name: 'brainstorm',
        status: 'completed',
        mode: 'interactive',
        startedAt: 1000,
        endedAt: 1500,
      },
    ])
  })

  it('lets live records override persisted status for the same step', () => {
    const state = runState({
      steps: { plan: makeStepEntry({ name: 'plan', startedAt: 2000, endedAt: 3000 }) },
    })
    const live = new Map<string, Omit<StepStatusRecord, 'name'>>([
      ['plan', { status: 'running', startedAt: 9000 }],
    ])

    const records = toStatusRecords({ state, live })
    expect(records).toEqual([{ name: 'plan', status: 'running', startedAt: 9000 }])
  })

  it('appends live-only records after persisted ones preserving insertion order', () => {
    const state = runState({
      steps: { a: makeStepEntry({ name: 'a', startedAt: 100, endedAt: 200 }) },
    })
    const live = new Map<string, Omit<StepStatusRecord, 'name'>>([
      ['b', { status: 'running', startedAt: 9500 }],
    ])

    const records = toStatusRecords({ state, live })
    expect(records.map((r) => r.name)).toEqual(['a', 'b'])
    expect(records[1]?.status).toBe('running')
  })
})

// ---------------------------------------------------------------------------
// renderStatusPane — pure line rendering
// ---------------------------------------------------------------------------

describe('renderStatusPane', () => {
  it('renders the empty-state line when no records are provided', () => {
    expect(renderStatusPane([], { now: NOW })).toEqual(['(no steps yet)'])
  })

  it('renders a running step with live elapsed time against now', () => {
    const lines = renderStatusPane([record({ name: 'plan', status: 'running', startedAt: 8800 })], {
      now: NOW,
    })
    expect(lines).toEqual(['● plan  1s'])
  })

  it('renders a completed step with its frozen duration instead of wall-clock elapsed', () => {
    const lines = renderStatusPane(
      [record({ name: 'brainstorm', status: 'completed', startedAt: 1000, endedAt: 3400 })],
      { now: 999_999 },
    )
    expect(lines).toEqual(['✓ brainstorm  2s'])
  })

  it('renders a pending step without a duration column', () => {
    const lines = renderStatusPane([record({ name: 'review', status: 'pending' })], { now: NOW })
    expect(lines).toEqual(['○ review'])
  })

  it('renders the run title above the step list when provided', () => {
    const lines = renderStatusPane([record({ name: 'plan', status: 'pending' })], {
      now: NOW,
      runTitle: 'r-2026-04-14-458000-q8 · hello-world',
    })
    expect(lines).toEqual(['r-2026-04-14-458000-q8 · hello-world', '', '○ plan'])
  })

  it('uses ASCII glyphs and strips ANSI from step names when tty is false', () => {
    const lines = renderStatusPane(
      [record({ name: '\u001b[31mplan\u001b[0m', status: 'running', startedAt: 9500 })],
      { now: NOW, tty: false },
    )
    expect(lines).toEqual(['* plan  500ms'])
  })

  it('renders a mixed list of interactive, cached, and failed steps with matching glyphs', () => {
    const lines = renderStatusPane(
      [
        record({ name: 'brainstorm', status: 'interactive', startedAt: 5000 }),
        record({ name: 'plan', status: 'cached' }),
        record({ name: 'work', status: 'failed', startedAt: 0, endedAt: 800 }),
      ],
      { now: NOW },
    )
    expect(lines).toEqual(['⟳ brainstorm  5s', '↺ plan', '✗ work  800ms'])
  })
})
