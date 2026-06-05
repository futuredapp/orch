// ---------------------------------------------------------------------------
// LeftPane — the steps pane, as the scenario sees it.
// ---------------------------------------------------------------------------
//
// SEMANTIC methods only. Expected chrome (footer hints, glyphs, labels) lives
// in the co-located `TEXT` constant below — an INDEPENDENT specification of
// what the user should see, NEVER imported from `src/` (D10). An imported
// production symbol on both sides of an assertion is tautological: it would
// stay green through a production wording typo. A co-located literal goes red.
//
// The only free-string method is `assertShowsContent`, for literals the test
// itself authored. Chrome literals must not appear inline in a scenario file.

import type { GlyphName, PaneDriver } from './pane-driver.ts'

export class LeftPane {
  // Expected chrome — the independent spec. Mirror production wording here on
  // purpose; the screen/full-host drivers match these against real tmux bytes,
  // so a production typo surfaces as a red test, not a laundered pass.
  private static readonly TEXT = {
    quitHint: 'q quit',
    followHint: 'f live',
    // U5b — view-mode footer chrome (independent spec; never imported from src/).
    viewStepHint: '⏎ view step',
    helpHint: '? help',
    viewingPrefix: '⏸ viewing',
    // U5b — error-banner envelope around the test-authored text.
    errorBannerPrefix: '! ',
    errorBannerSuffix: ' · Esc dismiss',
    // U5b — end-of-run completion-count wording.
    completionPrefix: 'steps',
    completionSuffix: 'completed',
    // U5b — terminal-state footer (below the steps grid once the run ends).
    terminalFooterPrefix: 'run',
    terminalFooterActions: ' · q to quit · ⏎ to inspect',
  } as const

  // U5a/D-P4 — expected colour→state mapping. The independent spec of which
  // production palette colour each glyph/summary state must render in; a
  // production palette typo (green→blue) makes the rendered byte stop matching,
  // so the test goes RED rather than laundering the change. Ink colour NAMES,
  // mirrored on purpose — never imported from src/.
  private static readonly COLOR = {
    running: 'yellow',
    done: 'green',
    failed: 'red',
  } as const

  constructor(private readonly driver: PaneDriver) {}

  // --- semantic chrome assertions (no literal reaches the scenario) ---------

  assertQuitHintVisible(): Promise<void> {
    return this.driver.assertBottomText(LeftPane.TEXT.quitHint, { count: 1 })
  }

  /** The replay-mode footer carries the `f live` hint (live mode does not). */
  assertFollowLiveHintVisible(): Promise<void> {
    return this.driver.assertBottomText(LeftPane.TEXT.followHint, { count: 1 })
  }

  /** Live mode shows no `f live` hint — the inverse of the replay footer. */
  assertFollowLiveHintHidden(): Promise<void> {
    return this.driver.assertBottomText(LeftPane.TEXT.followHint, { count: 0 })
  }

  assertStepSelected(step: string): Promise<void> {
    return this.driver.assertSelected(step)
  }

  assertGlyph(step: string, glyph: GlyphName): Promise<void> {
    return this.driver.assertGlyph(step, glyph)
  }

  // --- content escape hatch (ONLY for test-authored strings) ----------------

  assertShowsContent(text: string): Promise<void> {
    return this.driver.assertContains(text)
  }

  /** Content escape hatch (negative): a test-authored string is NOT shown. */
  assertContentAbsent(text: string): Promise<void> {
    return this.driver.assertAbsent(text)
  }

  /** Chrome/hygiene: the pane shows no caret-notation echo bytes. */
  assertNoCaretEcho(): Promise<void> {
    return this.driver.assertNoCaretEcho()
  }

  // --- affordances ----------------------------------------------------------

  selectStep(step: string): Promise<void> {
    return this.driver.selectStep(step)
  }

  followLive(): Promise<void> {
    return this.driver.followLive()
  }

  // --- U5a: preview cursor, scroll/viewport, glyph colour -------------------

  /** Move the `↑/↓` preview cursor to `step` without committing the selection. */
  browseTo(step: string): Promise<void> {
    return this.driver.browseTo(step)
  }

  assertPreviewCursorOn(step: string): Promise<void> {
    return this.driver.assertPreviewCursorOn(step)
  }

  assertStepVisible(step: string): Promise<void> {
    return this.driver.assertStepVisible(step)
  }

  assertStepOffscreen(step: string): Promise<void> {
    return this.driver.assertStepOffscreen(step)
  }

  scrollToOldest(): Promise<void> {
    return this.driver.scrollToOldest()
  }

  scrollToLive(): Promise<void> {
    return this.driver.scrollToLive()
  }

  /** The `step` row renders its status glyph in the co-located expected colour (D-P4). */
  assertGlyphColor(step: string, glyph: GlyphName): Promise<void> {
    return this.driver.assertColored(step, LeftPane.COLOR[glyph])
  }

  // --- U5b: view-mode footer hints ------------------------------------------

  assertViewStepHintVisible(): Promise<void> {
    return this.driver.assertBottomText(LeftPane.TEXT.viewStepHint, { count: 1 })
  }

  assertHelpHintVisible(): Promise<void> {
    return this.driver.assertBottomText(LeftPane.TEXT.helpHint, { count: 1 })
  }

  /** Replay-mode footer leads with `⏸ viewing <step>`. */
  assertViewingHintVisible(step: string): Promise<void> {
    return this.driver.assertBottomText(`${LeftPane.TEXT.viewingPrefix} ${step}`, { count: 1 })
  }

  // --- U5b: banner ----------------------------------------------------------

  assertInfoBannerShows(text: string): Promise<void> {
    return this.driver.assertContains(text)
  }

  assertErrorBannerShows(text: string): Promise<void> {
    return this.driver.assertContains(
      `${LeftPane.TEXT.errorBannerPrefix}${text}${LeftPane.TEXT.errorBannerSuffix}`,
    )
  }

  /** The banner that showed `text` is no longer rendered (auto-cleared or dismissed). */
  assertBannerCleared(text: string): Promise<void> {
    return this.driver.assertAbsent(text)
  }

  // --- U5b: end-of-run summary ----------------------------------------------

  assertEndOfRunSummaryShows(text: string): Promise<void> {
    return this.driver.assertContains(text)
  }

  assertCompletionCount(done: number, total: number): Promise<void> {
    return this.driver.assertContains(
      `${LeftPane.TEXT.completionPrefix} ${done}/${total} ${LeftPane.TEXT.completionSuffix}`,
    )
  }

  /** The terminal-state footer (`run <state> · q to quit · ⏎ to inspect`). */
  assertTerminalFooterVisible(state: 'completed' | 'failed' | 'crashed'): Promise<void> {
    return this.driver.assertBottomText(
      `${LeftPane.TEXT.terminalFooterPrefix} ${state}${LeftPane.TEXT.terminalFooterActions}`,
      { count: 1 },
    )
  }

  /** The terminal-state status label renders in the co-located expected colour. */
  assertSummaryColor(state: 'completed' | 'failed' | 'crashed'): Promise<void> {
    const color = state === 'completed' ? LeftPane.COLOR.done : LeftPane.COLOR.failed
    return this.driver.assertColored(state, color)
  }
}
