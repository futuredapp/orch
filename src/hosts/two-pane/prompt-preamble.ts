// ---------------------------------------------------------------------------
// prompt-preamble — render the assembled prompt as a safe right-pane preamble.
// ---------------------------------------------------------------------------
//
// For every autonomous step, orch shows the exact prompt it sent the agent at
// the top of that step's right pane, above the agent's streamed output. This
// module is the pure half of that feature: it (a) escapes control bytes in the
// prompt to a *visible* representation and (b) wraps the escaped prompt in a
// `prompt:` label + separator so a reader can tell where the prompt ends and
// the agent's output begins.
//
// Why escape, not strip (R6): a prompt can contain arbitrary control/escape
// bytes — cursor moves, screen-clear (`\x1b[2J`), an OSC 52 clipboard write, an
// OSC 8 hyperlink. The right-pane render path interprets those on screen even
// when the underlying tee write is byte-faithful, so a passthrough prompt could
// corrupt the pane or silently act on the watcher's terminal. `stripAnsi`
// (`src/hosts/plain/strip-ansi.ts`) *deletes* such sequences; here we must keep
// the content *visible* as literal text, so we convert each control code point
// to a Unicode Control Picture instead of removing it.
//
// Why code points, not raw UTF-8 bytes (KTD3 / FL-4): like `stripAnsi`, this
// operates on the JS string via a regex over code points. Escaping the raw
// UTF-8 encoding would corrupt any non-ASCII text whose multi-byte encoding
// contains `0x80–0x9F` continuation bytes. `café` / `日本語` / emoji must pass
// through untouched; only genuine control *code points* are escaped.
//
// Neutralizing CSI/OSC/DCS/APC falls out of escaping the ESC introducer
// (`U+001B`) and the 8-bit C1 introducers (`U+0080–U+009F`): once the introducer
// is a printable glyph, the trailing payload bytes (`[2J`, `]52;c;…`) are
// already printable and render as literal text — no sequence parser needed.

const ESC = 0x1b

// Map a control code point to a visible Unicode Control Picture (U+2400 block).
// C0 controls `U+0000–U+001F` map to `U+2400–U+241F`; DEL `U+007F` maps to the
// dedicated `U+2421` (SYMBOL FOR DELETE). The U+2400 block is unambiguous and
// avoids colliding with the `^[`/`^M`/`^J` caret-echo smell that
// `assertNoCaretEcho` already flags.
const PICTURE_BASE = 0x2400
const DEL = 0x7f
const SYMBOL_FOR_DELETE = 0x2421

// A C1 control (`U+0080–U+009F`) is the 8-bit form of a two-byte `ESC <final>`
// sequence where `<final>` is `cp - 0x40` — a *printable* ASCII char (e.g. 8-bit
// CSI `U+009B` ≡ `ESC [`). Render it as the ESC picture + that printable final,
// so the 8-bit introducer cannot survive as an interpretable byte while still
// reading as the escape it stood for.
const C1_LOW = 0x80
const C1_HIGH = 0x9f
const C1_TO_7BIT_OFFSET = 0x40

function escapeCodePoint(cp: number): string {
  // ESC: its own picture (U+241B SYMBOL FOR ESCAPE).
  if (cp === ESC) return String.fromCodePoint(PICTURE_BASE + ESC)
  // DEL.
  if (cp === DEL) return String.fromCodePoint(SYMBOL_FOR_DELETE)
  // C0 controls except TAB (`\t`, U+0009) and LF (`\n`, U+000A), which are
  // legitimate text whitespace and must survive so a multi-line prompt keeps
  // its layout.
  if (cp <= 0x1f) return String.fromCodePoint(PICTURE_BASE + cp)
  // C1 controls: ESC picture + the 7-bit printable final byte it expands to.
  if (cp >= C1_LOW && cp <= C1_HIGH) {
    return String.fromCodePoint(PICTURE_BASE + ESC) + String.fromCodePoint(cp - C1_TO_7BIT_OFFSET)
  }
  return String.fromCodePoint(cp)
}

// Code points to escape: every C0 except TAB/LF, DEL, and every C1. Built as a
// regex over the string (like `strip-ansi`'s CONTROL_CHARS_RE) but emitting a
// visible glyph rather than deleting.
// biome-ignore lint/suspicious/noControlCharactersInRegex: this escaper's job is precisely to make control characters visible
const CONTROL_CODE_POINTS_RE = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g

/**
 * Convert every control code point in `text` to a visible Unicode Control
 * Picture, leaving all other Unicode text (including non-ASCII letters and
 * emoji) and the whitespace controls TAB/LF unchanged. Operates on code
 * points, never raw UTF-8 bytes.
 *
 * Escaping the ESC introducer (`U+001B`) and the 8-bit C1 introducers
 * neutralizes CSI/OSC/DCS/APC sequences: the remaining (printable) payload
 * renders as literal text.
 */
export function escapeControlBytesToVisible(text: string): string {
  return text.replace(CONTROL_CODE_POINTS_RE, (ch) => escapeCodePoint(ch.codePointAt(0) ?? 0))
}

// --- preamble chrome (production source of truth) --------------------------
//
// These literals are mirrored — never imported — by the test-side chrome
// constants on the `RightPane` Pane Object (`tests/dsl/panes/right-pane.ts`),
// per CLAUDE.md "how to write a two-pane test". A wording change here must be
// reflected there, where it surfaces as a red test rather than a laundered pass.

/** The label line that opens the preamble. */
export const PROMPT_LABEL = 'prompt:'
/** A full-width-ish rule of box-drawing horizontals separating prompt + output. */
export const PROMPT_SEPARATOR = '─'.repeat(60)

// tmux host convention: lines are CRLF-terminated (mirrors
// `src/hosts/plain/per-step-tee.ts` and the `[<step>] starting…` marker the
// preamble replaces).
const CRLF = '\r\n'

/**
 * Render the right-pane preamble for an assembled prompt: a `prompt:` label
 * line, the control-escaped prompt, then a separator line — each CRLF-
 * terminated — after which the agent's output flows normally. Pure; no I/O.
 */
export function renderPromptPreamble(prompt: string): string {
  const escaped = escapeControlBytesToVisible(prompt)
  return `${PROMPT_LABEL}${CRLF}${escaped}${CRLF}${PROMPT_SEPARATOR}${CRLF}`
}
