// ---------------------------------------------------------------------------
// render-line — TranscriptLine → strings the host writes verbatim.
// ---------------------------------------------------------------------------
//
// The runner pre-formats every event into one or more `TranscriptLine`s.
// This module owns presentation: glyph + color per category, block heading +
// indented rows, optional `[<step>] ` prefix on `kind: 'line'` items. Block
// lines never carry the prefix — the heading owns the step's context.
//
// `body` always passes through `stripAnsi` before the ANSI wrapper is added,
// so a malicious tool result can't poison the terminal even when colors are
// on. The host renderer chooses `color` from `process.stdout.isTTY` and
// `NO_COLOR`; tmux always passes `color: true`.

import type { TranscriptCategory, TranscriptLine } from '../../runners/index.ts'
import { stripAnsi } from './strip-ansi.ts'

export interface RenderOptions {
  readonly color: boolean
  /** Prefix for `kind: 'line'` items (typically `[<stepName>] `). */
  readonly prefix: string
}

// ESC byte built via fromCharCode to keep the source file free of literal
// control characters (mirrors strip-ansi.ts).
const ESC = String.fromCharCode(0x1b)
const RESET = `${ESC}[0m`
const DIM = `${ESC}[2m`
const BOLD = `${ESC}[1m`
const RED_BRIGHT = `${ESC}[91m`
const CYAN = `${ESC}[36m`
const WHITE_BRIGHT = `${ESC}[97m`

interface CategoryStyle {
  readonly glyph: string
  readonly color?: string
}

const STYLES: Record<TranscriptCategory, CategoryStyle> = {
  system: { glyph: '·', color: DIM },
  thinking: { glyph: '○', color: DIM },
  'tool-call': { glyph: '▸', color: CYAN },
  'tool-result': { glyph: '◂', color: DIM },
  'tool-error': { glyph: '✗', color: RED_BRIGHT },
  assistant: { glyph: '', color: WHITE_BRIGHT },
}

export function renderTranscriptLine(line: TranscriptLine, opts: RenderOptions): readonly string[] {
  if (line.kind === 'block') return renderBlock(line, opts)
  return [renderLine(line, opts)]
}

function renderLine(line: Extract<TranscriptLine, { kind: 'line' }>, opts: RenderOptions): string {
  const style = STYLES[line.category]
  const cleanBody = stripAnsi(line.body)
  const head = headFor(line, style, opts.color)
  const trailing = cleanBody.length > 0 ? ` ${cleanBody}` : ''
  return `${opts.prefix}${head}${trailing}`
}

function headFor(
  line: Extract<TranscriptLine, { kind: 'line' }>,
  style: CategoryStyle,
  color: boolean,
): string {
  // Assistant lines lead with the label only; other categories lead with a
  // single-glyph marker, optionally followed by a label (e.g. tool name).
  if (line.category === 'assistant') {
    const label = line.label ?? 'assistant>'
    return paint(label, style.color, color)
  }
  const labelPart = line.label !== undefined ? ` ${line.label}` : ''
  const head = `${style.glyph}${labelPart}`
  return paint(head, style.color, color)
}

function renderBlock(
  block: Extract<TranscriptLine, { kind: 'block' }>,
  opts: RenderOptions,
): readonly string[] {
  const heading = block.heading === 'done' ? '── done ──' : '── failed ──'
  const out: string[] = [paint(heading, BOLD, opts.color)]
  if (block.rows.length === 0) return out
  const labelWidth = block.rows.reduce((max, [label]) => Math.max(max, label.length), 0)
  for (const [label, value] of block.rows) {
    const padded = label.padEnd(labelWidth, ' ')
    const dimLabel = paint(padded, DIM, opts.color)
    const cleanValue = stripAnsi(value)
    out.push(`  ${dimLabel}  ${cleanValue}`)
  }
  return out
}

function paint(s: string, code: string | undefined, color: boolean): string {
  if (!color || code === undefined || s.length === 0) return s
  return `${code}${s}${RESET}`
}
