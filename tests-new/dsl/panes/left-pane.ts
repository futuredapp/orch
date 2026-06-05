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
  } as const

  constructor(private readonly driver: PaneDriver) {}

  // --- semantic chrome assertions (no literal reaches the scenario) ---------

  assertQuitHintVisible(): Promise<void> {
    return this.driver.assertBottomText(LeftPane.TEXT.quitHint, { count: 1 })
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
}
