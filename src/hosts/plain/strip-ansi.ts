// ---------------------------------------------------------------------------
// strip-ansi — sanitizer for transcript bytes printed to a TTY or pipe.
// ---------------------------------------------------------------------------
//
// Assistant messages and tool results arrive raw from the runner adapter. A
// malicious MCP tool returning `\x1b]52;c;<base64>\x07` would hijack the
// clipboard on every `--mode=plain` invocation. The stripper runs at print
// time (not at store time, so structured consumers keep the raw bytes) and
// strips the full DEC/ANSI family — not just SGR.
//
// Contract:
//   - Keeps `\n` and `\t` (the only whitespace controls that belong in text).
//   - Drops every other C0 (0x00–0x1F), every C1 (0x80–0x9F), and the DEL 0x7F.
//   - Drops CSI  `\x1b[ ... final`                 (0x40–0x7E final byte)
//   - Drops OSC  `\x1b] ... (BEL | ESC\\)`
//   - Drops DCS  `\x1bP ... (ESC\\)`
//   - Drops any other ESC + single-byte sequence (`\x1b[=?>`, ST, RIS, …).
//
// The regex is built from the xterm ctlseqs table rather than a curated SGR
// allowlist so OSC 52 (clipboard), OSC 8 (hyperlinks), DCS (Sixel) and
// Kitty-style APC escapes all fall out without special-casing.

const ESC = '\x1b'
const BEL = '\x07'

// Ordered pieces; the regex leans on the first match-in-alternation property.
const CSI = String.raw`\x1b\[[0-?]*[ -/]*[@-~]`
const OSC_BEL = String.raw`\x1b\][^\x07\x1b]*\x07`
const OSC_ST = String.raw`\x1b\][^\x1b]*\x1b\\`
const DCS = String.raw`\x1bP[^\x1b]*\x1b\\`
// Anything after ESC that isn't one of the structured intros above: eat the
// ESC + one trailing byte (RIS `\x1bc`, IND `\x1bD`, etc.).
const ESC_SHORT = String.raw`\x1b[@-_]`

const ESC_SEQ_RE = new RegExp(`${CSI}|${OSC_BEL}|${OSC_ST}|${DCS}|${ESC_SHORT}`, 'g')

// C0 (0x00–0x1F) except TAB/LF, DEL (0x7F), and C1 (0x80–0x9F). We strip C1
// as raw bytes because terminals interpret them as a 7-bit ESC prefix when
// the output is 8-bit clean — a poison path OSC can exploit.
// biome-ignore lint/suspicious/noControlCharactersInRegex: this stripper's job is precisely to filter control characters
const CONTROL_CHARS_RE = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g

export function stripAnsi(text: string): string {
  // First pass: drop structured ESC sequences (CSI/OSC/DCS) so their payload
  // bytes don't get re-interpreted on the second pass.
  const withoutEscapes = text.replace(ESC_SEQ_RE, '')
  // Second pass: drop bare C0/C1/DEL bytes.
  return withoutEscapes.replace(CONTROL_CHARS_RE, '')
}

export const ESC_CHAR = ESC
export const BEL_CHAR = BEL
