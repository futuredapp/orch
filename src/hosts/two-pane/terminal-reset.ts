// ---------------------------------------------------------------------------
// terminal-reset — restore the outer TTY after tmux hands it back.
// ---------------------------------------------------------------------------
//
// tmux is documented to leak terminal modes when its client exits (see tmux
// GitHub #2116 — unresolved): SGR mouse tracking (?1006), alt-screen (?1049),
// bracketed paste (?2004). Symptoms: mouse movements render as `M<32;...>`
// strings in the outer shell, typing appears garbled, prompts redraw on top
// of each other.
//
// We counter by emitting the canonical DEC private-mode reset sequences after
// the attach client returns. Writing a reset for a mode that was not set is
// a safe no-op — terminals just silently accept it.

/**
 * Disable every terminal mode that tmux (or a runner inside it) could have
 * left on. Guarded on `isTTY` so unit tests and piped invocations
 * (`orch ... | tee`) never have escape bytes injected into their output.
 *
 * Kept in `src/hosts/two-pane/` because tmux is the only host that sets these
 * modes. Promote to `src/services/terminal/` if another host ever needs it.
 */
export function restoreTerminalModes(stream: NodeJS.WritableStream): void {
  // `isTTY` is optional on the WritableStream type — present on
  // `process.stdout` when attached to a terminal, absent on PassThrough /
  // file descriptors / piped output.
  const tty = (stream as { isTTY?: boolean }).isTTY === true
  if (!tty) return

  // Order mirrors the layering: mouse modes first (the primary symptom),
  // then screen buffers and paste modes, then cursor-key mode. Each is an
  // independent DEC private mode; order is not strictly required but keeps
  // the bytes stable for test assertions.
  stream.write(TERMINAL_RESET_SEQUENCES)
}

/**
 * The exact byte sequence `restoreTerminalModes` emits. Exported so tests
 * can assert equality without duplicating the literal.
 */
export const TERMINAL_RESET_SEQUENCES =
  '\x1b[?1000l' + // normal mouse tracking off
  '\x1b[?1002l' + // button-event mouse off
  '\x1b[?1003l' + // any-event mouse off
  '\x1b[?1005l' + // UTF-8 mouse off
  '\x1b[?1006l' + // SGR mouse off (the one causing `M<32;57;50M` artifacts)
  '\x1b[?1049l' + // exit alternate screen buffer
  '\x1b[?2004l' + // bracketed paste off
  '\x1b[?1l' // application cursor keys off
