// Unit coverage for the prompt-preamble module — the pure escaper + renderer
// behind "show the assembled prompt at the top of an autonomous step's right
// pane" (Phase 1, U1).
//
// Triage: each test asserts a control code point becomes a *visible* glyph (not
// deleted, not passed through) or that non-control Unicode survives intact. It
// would fail if the escaper stripped instead of escaped, corrupted multi-byte
// text, or let a raw ESC/BEL survive — so it passes the testing-strategy
// "would this still pass if the behaviour were wrong?" gate.

import { describe, expect, it } from 'bun:test'
import {
  escapeControlBytesToVisible,
  PROMPT_LABEL,
  PROMPT_SEPARATOR,
  renderPromptPreamble,
} from '../../../../src/hosts/two-pane/prompt-preamble.ts'

const ESC = '\x1b'
const BEL = '\x07'
const DEL = '\x7f'
const ESC_PICTURE = '␛' // SYMBOL FOR ESCAPE (U+241B)
const DEL_PICTURE = '␡' // SYMBOL FOR DELETE (U+2421)

describe('escapeControlBytesToVisible', () => {
  it('converts a lone ESC to its visible glyph and leaves the following printable bytes intact', () => {
    const input = `${ESC}[2J`

    const out = escapeControlBytesToVisible(input)

    expect(out).not.toContain(ESC)
    expect(out).toContain(ESC_PICTURE)
    expect(out).toContain('[2J')
  })

  it('Covers AE6. renders an OSC 52 clipboard sequence as visible text with no raw ESC or BEL surviving', () => {
    const osc52 = `${ESC}]52;c;aGVsbG8=${BEL}`

    const out = escapeControlBytesToVisible(osc52)

    expect(out).not.toContain(ESC)
    expect(out).not.toContain(BEL)
    expect(out).toContain('52;c;aGVsbG8=')
  })

  it('preserves \\n and \\t but converts \\r, NUL, and other C0 code points', () => {
    const input = 'a\tb\nc\rd\x00e\x07f'

    const out = escapeControlBytesToVisible(input)

    expect(out).toContain('\t')
    expect(out).toContain('\n')
    expect(out).not.toContain('\r')
    expect(out).not.toContain('\x00')
    expect(out).not.toContain('\x07')
    expect(out).toContain('␍') // CR picture
    expect(out).toContain('␀') // NUL picture
  })

  it('converts C1 code points (U+0080–U+009F) to a visible form so the 8-bit CSI introducer cannot survive', () => {
    const csi8bit = '' // 8-bit CSI

    const out = escapeControlBytesToVisible(csi8bit)

    expect(out).not.toContain('')
    expect(out).toContain(ESC_PICTURE)
  })

  it('converts DEL (U+007F) to its visible delete glyph while leaving the surrounding printable bytes intact', () => {
    const input = `a${DEL}b`

    const out = escapeControlBytesToVisible(input)

    expect(out).not.toContain(DEL)
    expect(out).toContain(DEL_PICTURE)
    expect(out).toContain('a')
    expect(out).toContain('b')
  })

  it('escapes an ESC abutting an emoji on both sides without corrupting either surrogate pair', () => {
    const input = `🎉${ESC}[2J🎉`

    const out = escapeControlBytesToVisible(input)

    expect(out).not.toContain(ESC)
    expect(out).toContain(ESC_PICTURE)
    expect(out.split('🎉')).toHaveLength(3) // both 🎉 survive intact, one on each side of the escape
    expect(out).toContain('[2J')
  })

  it('Covers F4. keeps non-ASCII text intact while escaping every embedded control', () => {
    const input = `café ${ESC}[31m 日本語 ${ESC}]52;c;eA==${BEL} 🎉 `

    const out = escapeControlBytesToVisible(input)

    expect(out).toContain('café')
    expect(out).toContain('日本語')
    expect(out).toContain('🎉')
    expect(out).not.toContain(ESC)
    expect(out).not.toContain(BEL)
    expect(out).not.toContain('')
  })
})

describe('renderPromptPreamble', () => {
  it('begins with the prompt: label and ends with the separator line', () => {
    const out = renderPromptPreamble('do the thing')

    expect(out.startsWith(`${PROMPT_LABEL}\r\n`)).toBe(true)
    expect(out.trimEnd().endsWith(PROMPT_SEPARATOR)).toBe(true)
    expect(out).toContain('do the thing')
  })

  it('keeps a multi-line prompt’s internal newlines', () => {
    const out = renderPromptPreamble('line one\nline two\nline three')

    expect(out).toContain('line one\nline two\nline three')
  })

  it('renders a several-hundred-line prompt in full with nothing elided', () => {
    const lines = Array.from({ length: 400 }, (_, i) => `prompt-line-${i}`)
    const prompt = lines.join('\n')

    const out = renderPromptPreamble(prompt)

    expect(out).toContain('prompt-line-0')
    expect(out).toContain('prompt-line-399')
    expect(out).not.toContain('…')
  })

  it('escapes control bytes in the prompt body so no raw ESC reaches the pane', () => {
    const out = renderPromptPreamble(`hi ${ESC}[2J there`)

    expect(out).not.toContain(ESC)
    expect(out).toContain(ESC_PICTURE)
  })
})
