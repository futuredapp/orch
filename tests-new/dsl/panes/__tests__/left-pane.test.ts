import { describe, expect, it } from 'bun:test'
import { LeftPane } from '../left-pane.ts'
import type { GlyphName, PaneDriver } from '../pane-driver.ts'

// A PaneDriver that records what literals the Pane Object asked it to assert.
// This is how we prove the chrome literal is co-located on `LeftPane` (D10) and
// not laundered in from `src/`: the meta-test pins the exact string LeftPane
// emits, so changing the co-located constant to a wrong value goes red here.
class CapturingPaneDriver implements PaneDriver {
  readonly bottomTextCalls: { literal: string; count: number }[] = []
  readonly containsCalls: string[] = []
  readonly absentCalls: string[] = []
  readonly coloredCalls: { needle: string; colorName: string }[] = []

  assertBottomText(literal: string, opts: { count: number }): Promise<void> {
    this.bottomTextCalls.push({ literal, count: opts.count })
    return Promise.resolve()
  }
  assertContains(text: string): Promise<void> {
    this.containsCalls.push(text)
    return Promise.resolve()
  }
  assertSelected(_step: string): Promise<void> {
    return Promise.resolve()
  }
  assertGlyph(_step: string, _glyph: GlyphName): Promise<void> {
    return Promise.resolve()
  }
  selectStep(_step: string): Promise<void> {
    return Promise.resolve()
  }
  followLive(): Promise<void> {
    return Promise.resolve()
  }
  browseTo(_step: string): Promise<void> {
    return Promise.resolve()
  }
  assertPreviewCursorOn(_step: string): Promise<void> {
    return Promise.resolve()
  }
  assertStepVisible(_step: string): Promise<void> {
    return Promise.resolve()
  }
  assertStepOffscreen(_step: string): Promise<void> {
    return Promise.resolve()
  }
  scrollToOldest(): Promise<void> {
    return Promise.resolve()
  }
  scrollToLive(): Promise<void> {
    return Promise.resolve()
  }
  assertColored(needle: string, colorName: string): Promise<void> {
    this.coloredCalls.push({ needle, colorName })
    return Promise.resolve()
  }
  assertAbsent(text: string): Promise<void> {
    this.absentCalls.push(text)
    return Promise.resolve()
  }
  assertNoCaretEcho(): Promise<void> {
    return Promise.resolve()
  }
}

describe('LeftPane chrome literals are co-located and independent of src/', () => {
  it('asserts the exact quit-hint literal "q quit" exactly once', async () => {
    const driver = new CapturingPaneDriver()
    const leftPane = new LeftPane(driver)

    await leftPane.assertQuitHintVisible()

    // This is the D10 guard: a production typo in the steps-view footer would
    // change the bytes, not this constant, so the screen driver would go red —
    // and corrupting THIS constant fails this meta-test instead of passing.
    expect(driver.bottomTextCalls).toEqual([{ literal: 'q quit', count: 1 }])
  })
})

describe('LeftPane content escape hatch forwards verbatim', () => {
  it('passes test-authored content straight through to assertContains', async () => {
    const driver = new CapturingPaneDriver()
    const leftPane = new LeftPane(driver)

    await leftPane.assertShowsContent('a string the test wrote')

    expect(driver.containsCalls).toEqual(['a string the test wrote'])
  })
})

describe('LeftPane U5b footer/banner/summary chrome is co-located (D10/D-P4)', () => {
  it('emits the exact view-step and help footer hints once each', async () => {
    const driver = new CapturingPaneDriver()
    const leftPane = new LeftPane(driver)

    await leftPane.assertViewStepHintVisible()
    await leftPane.assertHelpHintVisible()
    await leftPane.assertViewingHintVisible('plan')

    expect(driver.bottomTextCalls).toEqual([
      { literal: '⏎ view step', count: 1 },
      { literal: '? help', count: 1 },
      { literal: '⏸ viewing plan', count: 1 },
    ])
  })

  it('wraps an error-banner text in the co-located "! … · Esc dismiss" envelope', async () => {
    const driver = new CapturingPaneDriver()
    const leftPane = new LeftPane(driver)

    await leftPane.assertErrorBannerShows('boom')

    expect(driver.containsCalls).toEqual(['! boom · Esc dismiss'])
  })

  it('renders the completion count with the co-located "steps x/y completed" wording', async () => {
    const driver = new CapturingPaneDriver()
    const leftPane = new LeftPane(driver)

    await leftPane.assertCompletionCount(2, 3)

    expect(driver.containsCalls).toEqual(['steps 2/3 completed'])
  })

  it('checks the banner text is absent when asserting it cleared', async () => {
    const driver = new CapturingPaneDriver()
    const leftPane = new LeftPane(driver)

    await leftPane.assertBannerCleared('saved')

    expect(driver.absentCalls).toEqual(['saved'])
  })
})

describe('LeftPane colour tokens are the co-located independent spec (D-P4)', () => {
  it('maps each glyph state to its expected colour name', async () => {
    const driver = new CapturingPaneDriver()
    const leftPane = new LeftPane(driver)

    await leftPane.assertGlyphColor('plan', 'running')
    await leftPane.assertGlyphColor('plan', 'done')
    await leftPane.assertGlyphColor('plan', 'failed')

    expect(driver.coloredCalls).toEqual([
      { needle: 'plan', colorName: 'yellow' },
      { needle: 'plan', colorName: 'green' },
      { needle: 'plan', colorName: 'red' },
    ])
  })

  it('maps the terminal summary state to its expected colour name', async () => {
    const driver = new CapturingPaneDriver()
    const leftPane = new LeftPane(driver)

    await leftPane.assertSummaryColor('completed')
    await leftPane.assertSummaryColor('failed')

    expect(driver.coloredCalls).toEqual([
      { needle: 'completed', colorName: 'green' },
      { needle: 'failed', colorName: 'red' },
    ])
  })
})
