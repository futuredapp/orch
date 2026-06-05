// ---------------------------------------------------------------------------
// PaneDriver — the driver-facing capability seam behind every Pane Object.
// ---------------------------------------------------------------------------
//
// A Pane Object (LeftPane / RightPane) is driver-INDEPENDENT: it speaks
// semantic methods to the scenario and asks its `PaneDriver` for raw
// capabilities. Each driver decides what a capability MEANS at its fidelity —
// on `model` "assert bottom text" inspects the projected/rendered view-model;
// on `screen`/`full-host` it captures actual bytes off real tmux. Scenarios
// never see this interface; only drivers implement it.

/** Step status glyph a row can render. Maps to the production glyph at the driver. */
export type GlyphName = 'running' | 'done' | 'failed'

/**
 * Caret-notation sequences that betray the legacy pty echo-doubling bug. A
 * clean right pane (file-tail model) never emits these. Shared so every driver's
 * `assertNoCaretEcho` pins the same set.
 */
export const CARET_ECHO_TOKENS = ['^[', '^M', '^J'] as const

export interface PaneDriver {
  /**
   * Assert the chrome `literal` appears `count` times in the pane's bottom
   * region (footer). The `count` guard catches a double-rendered footer.
   */
  assertBottomText(literal: string, opts: { readonly count: number }): Promise<void>
  /** Assert the pane contains `text` somewhere. The free-string content path. */
  assertContains(text: string): Promise<void>
  /** Assert `step` is the committed (right-pane-tracking) selection. */
  assertSelected(step: string): Promise<void>
  /** Assert `step`'s row renders the glyph for `glyph`. */
  assertGlyph(step: string, glyph: GlyphName): Promise<void>
  /** Drive the pane to select `step` (commit it). */
  selectStep(step: string): Promise<void>
  /** Drive the pane to follow the live step (snap-to-live). */
  followLive(): Promise<void>
  /**
   * Assert the pane shows no caret-notation echo bytes (`^[`, `^M`, `^J`) — the
   * calling card of the legacy pty doubling bug. Only meaningful on a real-tmux
   * driver, where the bytes actually round-trip a terminal; on `model` it holds
   * trivially over the rendered frame.
   */
  assertNoCaretEcho(): Promise<void>
}
