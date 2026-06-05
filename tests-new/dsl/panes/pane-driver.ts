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

  // --- U5a: preview cursor, scroll/viewport, colour -------------------------

  /** Move the `↑/↓` preview cursor to `step` WITHOUT committing it. */
  browseTo(step: string): Promise<void>
  /** Assert `step` is the row under the `↑/↓` preview cursor (not yet committed). */
  assertPreviewCursorOn(step: string): Promise<void>
  /** Assert `step`'s row is inside the rendered viewport window. */
  assertStepVisible(step: string): Promise<void>
  /** Assert `step`'s row is scrolled out of the rendered viewport window. */
  assertStepOffscreen(step: string): Promise<void>
  /** Scroll the viewport to the oldest step (Home / `g` — jump to top). */
  scrollToOldest(): Promise<void>
  /** Scroll the viewport back to the live tail (End / `G` — jump to bottom). */
  scrollToLive(): Promise<void>
  /**
   * Assert the line containing `lineNeedle` carries an SGR escape selecting
   * `colorName` (D-P4 — glyph/summary colour). `colorName` is the co-located
   * independent spec from the Pane Object, never a `src/` import.
   */
  assertColored(lineNeedle: string, colorName: string): Promise<void>

  // --- U5b: banner / end-of-run absence -------------------------------------

  /** Assert `text` is NOT present in the pane (a cleared banner, a hidden row). */
  assertAbsent(text: string): Promise<void>
  /**
   * Assert the pane shows no caret-notation echo bytes (`^[`, `^M`, `^J`) — the
   * calling card of the legacy pty doubling bug. Only meaningful on a real-tmux
   * driver, where the bytes actually round-trip a terminal; on `model` it holds
   * trivially over the rendered frame.
   */
  assertNoCaretEcho(): Promise<void>
}
