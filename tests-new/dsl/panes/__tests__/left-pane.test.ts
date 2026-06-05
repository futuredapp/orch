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
