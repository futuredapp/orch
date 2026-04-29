// Integration: pipe a captured Claude NDJSON transcript through the full
// chain (parseClaudeLine → toClaudeTranscriptLines → renderTranscriptLine)
// and assert the rendered output. The fixture lives under tests/fixtures/
// so it survives `examples/.orch/state/` cleanup.
//
// One test asserts the plain-text shape (color: false) without coupling to
// ANSI escape sequences. A second assertion re-runs with `color: true` and
// verifies the output contains escape codes (presence check).

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { renderTranscriptLine } from '../../../../src/hosts/plain/render-line.ts'
import { toClaudeTranscriptLines } from '../../../../src/runners/claude/format-event.ts'
import { parseClaudeLine } from '../../../../src/runners/claude/index.ts'

const FIXTURE = path.join(
  import.meta.dir,
  '../../../fixtures/claude/r-2026-04-28-596832-e1.transcript.ndjson',
)

function renderFixture(color: boolean): string {
  const raw = readFileSync(FIXTURE, 'utf8')
  const out: string[] = []
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue
    // The captured file is per-event envelopes ({kind, type, payload|data})
    // not the raw Claude CLI shape — `parseClaudeLine` is for the latter.
    // Use JSON.parse here to reflect the on-disk transcript.ndjson contract.
    const evt = JSON.parse(line)
    const tlines = toClaudeTranscriptLines(evt)
    for (const tl of tlines) {
      const rendered = renderTranscriptLine(tl, {
        color,
        prefix: tl.kind === 'line' ? '[solve-riddle] ' : '',
      })
      for (const r of rendered) out.push(r)
    }
  }
  return out.join('\n')
}

describe('Claude transcript rendering — captured riddle-solve fixture', () => {
  it('renders the captured NDJSON into a readable plain-text transcript ending in a done block', () => {
    const text = renderFixture(false)

    // 1. System init line at the top.
    expect(text).toMatch(/^\[solve-riddle\] · system: model=claude-opus-4-7/m)

    // 2. The first tool call should be a Read of the riddle file (path in parens).
    expect(text).toMatch(/\[solve-riddle\] ▸ Read \(.+riddle\.txt\)/)

    // 3. A tool-error line is present (the second Write failed before Read).
    expect(text).toContain('[solve-riddle] ✗ ')
    expect(text).toMatch(/File has not been read yet/)

    // 4. The final assistant text block reaches the screen verbatim.
    expect(text).toContain('assistant>')
    expect(text).toMatch(/Wrote `the night sky` to solution\.txt/)

    // 5. The summary block lands at the end with rows.
    expect(text).toContain('── done ──')
    expect(text).toMatch(/^ {2}result\s+/m)
    expect(text).toMatch(/^ {2}duration\s+22\.2s/m)
    expect(text).toMatch(/^ {2}turns\s+6/m)
    expect(text).toMatch(/^ {2}cost\s+\$0\.\d{4}/m)
    expect(text).toMatch(/^ {2}tokens\s+cache R\/W: \d+k \/ \d+k/m)
    expect(text).toMatch(/^ {2}permissions\s+0 denials/m)

    // 6. The bug we are fixing: no `· <type>` fall-through lines anywhere.
    expect(text).not.toMatch(/\[solve-riddle\] · assistant\b/)
    expect(text).not.toMatch(/\[solve-riddle\] · user\b/)
  })

  it('emits ANSI escape sequences when color=true and none when color=false', () => {
    const colored = renderFixture(true)
    const plain = renderFixture(false)

    // Presence check, not specific sequences — survives chalk/library churn.
    expect(colored.includes('[')).toBe(true)
    expect(plain.includes('[')).toBe(false)
  })
})

// `parseClaudeLine` is not strictly needed for the fixture (it's already an
// envelope), but we keep this import-time reference so the symbol stays
// publicly visible from the runner barrel — flushes a name-only regression
// in code review without an extra test file.
void parseClaudeLine
