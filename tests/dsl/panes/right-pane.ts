// ---------------------------------------------------------------------------
// RightPane — the transcript / two-pane communication pane.
// ---------------------------------------------------------------------------
//
// Declared in U1 so `FullHostApp` / `LifecycleApp` typecheck, but only the
// full-host and lifecycle drivers (parent U2+) back it. The content escape
// hatch forwards to the driver; chrome/hygiene assertions are notImplemented
// until those drivers exist.

import { notImplemented } from '../not-implemented.ts'
import type { PaneDriver } from './pane-driver.ts'

export class RightPane {
  // Expected prompt-preamble chrome — the INDEPENDENT spec of what the
  // show-initial-prompt feature paints at the top of an autonomous step's pane.
  // Mirrors the production literals in `src/hosts/two-pane/prompt-preamble.ts`
  // (`PROMPT_LABEL` / `PROMPT_SEPARATOR`) on purpose, but is NEVER imported from
  // `src/` (CLAUDE.md): a production wording change makes the captured byte stop
  // matching, so the test goes RED rather than laundering the change.
  private static readonly TEXT = {
    // The label line that opens the preamble.
    promptLabel: 'prompt:',
    // A distinctive run of the box-drawing separator. Production paints a wider
    // rule; a shorter run stays contained even when a narrow pane wraps it.
    separatorSample: '─'.repeat(8),
  } as const

  // Raw OSC 52 introducer bytes. If the prompt's OSC 52 sequence were passed
  // through instead of escaped, tmux would consume these to write the clipboard
  // and they would NOT survive as visible text — so their absence, paired with
  // the escaped payload showing as text, is the "escaped not executed" proof.
  private static readonly OSC52_RAW = '\x1b]52'

  constructor(private readonly driver: PaneDriver) {}

  /** Content the test itself authored — the only free-string path. */
  assertShowsContent(text: string): Promise<void> {
    return this.driver.assertContains(text)
  }

  /**
   * `text` is NOT in the pane's visible viewport. For AT-9: when an autonomous
   * step opens pinned to the top of a tall prompt (R9), the agent's streamed
   * output — and the far end of the prompt — sit below the fold, so they must
   * be ABSENT from the captured viewport even though they were produced. The
   * driver's capture reads only the visible screen (not scrollback), so this is
   * a genuine "scrolled out of view" assertion, not "never rendered".
   */
  assertDoesNotShow(text: string): Promise<void> {
    return this.driver.assertAbsent(text)
  }

  /** The pane shows the `prompt:` label that opens the prompt preamble (R5). */
  assertShowsPromptLabel(): Promise<void> {
    return this.driver.assertContains(RightPane.TEXT.promptLabel)
  }

  /** The pane shows the separator rule that closes the prompt preamble (R5). */
  assertShowsPromptSeparator(): Promise<void> {
    return this.driver.assertContains(RightPane.TEXT.separatorSample)
  }

  /** The full prompt preamble chrome (label + separator) is present (R5). */
  async assertShowsPromptPreamble(): Promise<void> {
    await this.assertShowsPromptLabel()
    await this.assertShowsPromptSeparator()
  }

  /**
   * Chrome/hygiene: no raw OSC 52 clipboard-write bytes survive in the pane —
   * the sequence was escaped to visible text, not executed (R6 / AE6). Modeled
   * on `assertNoCaretEcho`.
   */
  assertNoOsc52(): Promise<void> {
    return this.driver.assertAbsent(RightPane.OSC52_RAW)
  }

  /** Chrome/hygiene: the right pane shows no echoed caret. */
  assertNoCaretEcho(): Promise<void> {
    return this.driver.assertNoCaretEcho()
  }

  /**
   * AT-6 / AE6 (OSC 52 sub-case): the prompt's OSC 52 clipboard-write was
   * escaped, NOT executed — the tmux paste buffer never received `payload`
   * (the decoded clipboard body). Pairs with `assertNoOsc52` (raw bytes absent
   * from pane text) and the escaped-payload-visible assertion to make the
   * "escaped not executed" guarantee falsifiable: with the appliance's
   * `set-clipboard on`, a passed-through OSC 52 would populate the buffer here.
   * real-tmux only — notImplemented elsewhere.
   */
  async assertClipboardUnchanged(payload: string): Promise<void> {
    if (this.driver.assertClipboardUnchanged === undefined) {
      await notImplemented('RightPane.assertClipboardUnchanged')
      return
    }
    await this.driver.assertClipboardUnchanged(payload)
  }

  /** This pane holds focus (lifecycle click-to-focus; notImplemented elsewhere). */
  assertFocused(): Promise<void> {
    return this.driver.assertFocused?.() ?? notImplemented('RightPane.assertFocused')
  }

  /**
   * R9 / AT-9: the autonomous step opened scrolled to the TOP of the prompt.
   * The pane is in copy-mode scrolled off the live tail, so its visible
   * viewport — what a watcher sees — shows `headMarker` (the start of the
   * prompt) and does NOT show `belowFoldMarker` (agent output / the prompt's
   * far end, which sit below the fold). Observed through the copy-mode-aware
   * viewport capture, because tmux `capture-pane -p` reports the live screen
   * and cannot see the copy-mode scroll. real-tmux only — notImplemented
   * elsewhere (AT-9 is a full-host behavior).
   */
  async assertOpenedAtPromptTop(headMarker: string, belowFoldMarker: string): Promise<void> {
    if (
      this.driver.assertVisibleViewportShows === undefined ||
      this.driver.assertVisibleViewportHides === undefined
    ) {
      await notImplemented('RightPane.assertOpenedAtPromptTop')
      return
    }
    await this.driver.assertVisibleViewportShows(headMarker)
    await this.driver.assertVisibleViewportHides(belowFoldMarker)
  }
}
