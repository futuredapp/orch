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
  constructor(private readonly driver: PaneDriver) {}

  /** Content the test itself authored — the only free-string path. */
  assertShowsContent(text: string): Promise<void> {
    return this.driver.assertContains(text)
  }

  /** Chrome/hygiene: the right pane shows no echoed caret. */
  assertNoCaretEcho(): Promise<void> {
    return notImplemented('RightPane.assertNoCaretEcho')
  }
}
