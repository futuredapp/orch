// Regression fence for the "doubled live output" bug.
//
// In two-pane mode the right pane was rendering each transcript line twice —
// once as caret-notation escapes (`^[[2m`, `^[[36m`, …) and once correctly
// rendered. The doubling lives below TmuxService at the kernel pty layer
// (line-discipline echo on a `cat` placeholder pane). These assertions pin
// the formatter as innocent: a future refactor that makes
// `renderTranscriptLine` return the same content twice, or that emits the
// literal three-character sequence `^[[`, would fail here BEFORE the bug
// could surface in the host.

import { describe, expect, it } from 'bun:test'
import { renderTranscriptLine } from '../../../../src/hosts/plain/render-line.ts'
import type { TranscriptCategory, TranscriptLine } from '../../../../src/runners/index.ts'

const CARET_ESC = '^[['
const PREFIX = '[work-0] '

const CATEGORIES: readonly TranscriptCategory[] = [
  'system',
  'thinking',
  'tool-call',
  'tool-result',
  'tool-error',
  'assistant',
] as const

const lineFor = (category: TranscriptCategory): TranscriptLine => ({
  kind: 'line',
  category,
  label: category === 'tool-call' ? 'Read' : undefined,
  body: 'hello world',
})

describe('renderTranscriptLine produces a single non-caret-escaped string per line', () => {
  for (const category of CATEGORIES) {
    it(`returns exactly one string for kind=line, category=${category}`, () => {
      const out = renderTranscriptLine(lineFor(category), { color: true, prefix: PREFIX })

      expect(out.length).toBe(1)
    })

    it(`never emits caret-notation escape sequences for category=${category}`, () => {
      const out = renderTranscriptLine(lineFor(category), { color: true, prefix: PREFIX })

      expect(out[0]).not.toContain(CARET_ESC)
    })
  }

  it('returns heading + one string per row for kind=block, with no caret escapes', () => {
    const block: TranscriptLine = {
      kind: 'block',
      heading: 'done',
      rows: [
        ['duration', '1.2s'],
        ['turns', '4'],
      ],
    }

    const out = renderTranscriptLine(block, { color: true, prefix: PREFIX })

    expect(out.length).toBe(1 + block.rows.length)
    for (const r of out) expect(r).not.toContain(CARET_ESC)
  })

  it('still emits real ANSI bytes when color is on (sanity check the escape sequence path)', () => {
    // If this assertion fails, the test above is vacuous — `paint()` was
    // silently disabled and there were never any escapes to caret-encode.
    const out = renderTranscriptLine(lineFor('thinking'), { color: true, prefix: PREFIX })

    const ESC = String.fromCharCode(0x1b)
    expect(out[0]).toContain(`${ESC}[`)
  })

  it('emits no escape bytes at all when color is off', () => {
    const out = renderTranscriptLine(lineFor('thinking'), { color: false, prefix: PREFIX })

    const ESC = String.fromCharCode(0x1b)
    expect(out[0]).not.toContain(ESC)
    expect(out[0]).not.toContain(CARET_ESC)
  })
})
