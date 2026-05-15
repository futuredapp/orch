// ---------------------------------------------------------------------------
// status-pane — pure renderer for the left status pane
// ---------------------------------------------------------------------------
//
// `renderStatusPane` has no I/O, no timers, and no dependencies on tmux. The
// status loop calls it on every lifecycle event and pipes the result into the
// left pane via `sendKeys`. Agents that prefer structured access consume
// `StepStatusRecord[]` directly without parsing rendered text.

import type { RunState, StepEntry } from '../state/index.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StepStatus = 'pending' | 'running' | 'interactive' | 'completed' | 'failed' | 'cached'

export interface StepStatusRecord {
  readonly name: string
  readonly status: StepStatus
  readonly mode?: 'interactive' | 'autonomous'
  readonly startedAt?: number
  readonly endedAt?: number
}

export interface RenderOptions {
  /** Wall-clock now, in milliseconds. Elapsed time uses `endedAt ?? now`. */
  readonly now: number
  /** `true` when stdout is a TTY → Unicode glyphs; `false` → ASCII fallback. */
  readonly tty?: boolean
  /** Optional header shown above the step list. */
  readonly runTitle?: string
}

// ---------------------------------------------------------------------------
// ANSI stripping
// ---------------------------------------------------------------------------
//
// User-supplied step names should never move the cursor or swap colors inside
// the status pane. We strip CSI sequences on render — the data model still
// carries the raw strings for anyone who wants them.

// Built via `new RegExp` so the source file stays free of literal control
// chars (biome's `noControlCharactersInRegex` flags inline \u001b otherwise).
const ESC = '\\u001b'
const BEL = '\\u0007'
const ANSI_CSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g')
const ANSI_OSC = new RegExp(`${ESC}\\].*?(?:${BEL}|${ESC}\\\\)`, 'g')

export function stripAnsi(s: string): string {
  return s.replace(ANSI_OSC, '').replace(ANSI_CSI, '')
}

// ---------------------------------------------------------------------------
// Glyphs
// ---------------------------------------------------------------------------
//
// The table is an object literal so snapshots in tests compare structurally.
// `cli/format.ts#glyphs` covers run-level status (`running` / `completed` /
// `crashed`); this table is step-level and strictly separate.

const UNICODE_STEP_GLYPHS: Record<StepStatus, string> = {
  pending: '○',
  running: '●',
  interactive: '⟳',
  completed: '✓',
  failed: '✗',
  cached: '↺',
}

const ASCII_STEP_GLYPHS: Record<StepStatus, string> = {
  pending: 'o',
  running: '*',
  interactive: '~',
  completed: '+',
  failed: 'x',
  cached: '.',
}

export function stepGlyph(status: StepStatus, tty: boolean): string {
  const table = tty ? UNICODE_STEP_GLYPHS : ASCII_STEP_GLYPHS
  return table[status]
}

// ---------------------------------------------------------------------------
// stepGlyphView — Ink view helper. Returns char + optional color/dim flags so
// the two-pane left view can render glyphs with semantic color without
// touching the plain-text `stepGlyph` consumers.
// ---------------------------------------------------------------------------

export interface StepGlyphView {
  readonly char: string
  readonly color?: string
  readonly dim?: boolean
}

// `running` and `pending` chars intentionally differ from `stepGlyph`'s
// table: the Ink left pane uses `◐` (yellow) and a dim `·` for visual weight,
// while the plain-text right-pane renderer keeps `●` / `○`.
const INK_STEP_VIEW: Record<StepStatus, StepGlyphView> = {
  pending: { char: '·', dim: true },
  running: { char: '◐', color: 'yellow' },
  interactive: { char: '⟳', dim: true },
  completed: { char: '✓', color: 'green' },
  failed: { char: '✗', color: 'red' },
  cached: { char: '↺', dim: true },
}

export function stepGlyphView(status: StepStatus): StepGlyphView {
  return INK_STEP_VIEW[status]
}

// ---------------------------------------------------------------------------
// Elapsed formatting — same rules as cli/format.ts#formatMs
// ---------------------------------------------------------------------------

export function formatElapsed(ms: number): string {
  if (ms < 0) return '0ms'
  if (ms < 1000) return `${ms}ms`
  const secs = Math.round(ms / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const remSecs = secs % 60
  return `${mins}m${remSecs}s`
}

function elapsedFor(record: StepStatusRecord, now: number): string {
  if (record.startedAt === undefined) return ''
  const end = record.endedAt ?? now
  return formatElapsed(end - record.startedAt)
}

// ---------------------------------------------------------------------------
// toStatusRecords — compose persisted state + live tracker into one list
// ---------------------------------------------------------------------------
//
// Persisted steps are always "completed" (or "cached" if live says so).
// Live records take precedence — they carry the authoritative status for
// steps currently in flight.

export function toStatusRecords(input: {
  readonly state?: RunState
  readonly live?: ReadonlyMap<string, Omit<StepStatusRecord, 'name'>>
}): StepStatusRecord[] {
  const records = new Map<string, StepStatusRecord>()

  if (input.state !== undefined) {
    for (const [name, entry] of Object.entries(input.state.steps)) {
      records.set(name, persistedToRecord(name, entry))
    }
  }

  if (input.live !== undefined) {
    for (const [name, live] of input.live) {
      records.set(name, { name, ...live })
    }
  }

  return [...records.values()]
}

function persistedToRecord(name: string, entry: StepEntry): StepStatusRecord {
  return {
    name,
    status: 'completed',
    ...(entry.mode !== undefined ? { mode: entry.mode } : {}),
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
  }
}

// ---------------------------------------------------------------------------
// renderStatusPane — pure. Returns lines; caller joins with \n.
// ---------------------------------------------------------------------------

export function renderStatusPane(
  records: readonly StepStatusRecord[],
  opts: RenderOptions,
): readonly string[] {
  const tty = opts.tty ?? true
  const lines: string[] = []

  if (opts.runTitle !== undefined) {
    lines.push(stripAnsi(opts.runTitle))
    lines.push('')
  }

  if (records.length === 0) {
    lines.push('(no steps yet)')
    return lines
  }

  for (const record of records) {
    lines.push(renderLine(record, opts.now, tty))
  }

  return lines
}

function renderLine(record: StepStatusRecord, now: number, tty: boolean): string {
  const glyph = stepGlyph(record.status, tty)
  const name = stripAnsi(record.name)
  const elapsed = elapsedFor(record, now)
  const suffix = elapsed.length > 0 ? `  ${elapsed}` : ''
  return `${glyph} ${name}${suffix}`
}
