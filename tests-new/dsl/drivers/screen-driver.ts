// ---------------------------------------------------------------------------
// screen driver (S2) — left/steps-pane BYTES on one real tmux pane (parent D4).
// ---------------------------------------------------------------------------
//
// Boots a dedicated single-pane steps-view fixture (no right-pane controller, no
// pane-map, no full host) and asserts the captured bytes against the co-located
// chrome literals. This is the only place footer placement, glyph rendering,
// wrapping, and narrow/wide widths are PROVEN — a fake tmux cannot (parent §5.1,
// §3.3). The driver owns `width`/`height`/`resize`; the `screen` risk class
// (wrapping, narrow/wide, re-render) lives here, not as one-offs.
//
// `ScreenApp` has no `rightPane` — a `screen` test exercises only the left pane
// (type-rejected; the property is also structurally absent at runtime).

import {
  canRunRealTmux,
  REAL_TMUX_ASSERT_TIMEOUT_MS,
  REAL_TMUX_TEST_TIMEOUT_MS,
} from '@orch/test/real-tmux/index.ts'
import {
  createSinglePaneStepsFixture,
  type SinglePaneStepsFixture,
} from '@orch/test/real-tmux/single-pane-steps-fixture.ts'
import type { DriverName, ScreenApp, ScreenSpec } from '../app-surfaces.ts'
import { LeftPane } from '../panes/left-pane.ts'
import type { ScenarioMeta } from '../scenario.ts'
import { createRealTmuxPaneDriver } from './real-tmux-pane-driver.ts'
import type { Driver } from './registry.ts'

const DRIVER_LABEL = 'screen'

function createScreenApp(fixture: SinglePaneStepsFixture): ScreenApp {
  let stepNames: readonly string[] = []

  const leftPane = new LeftPane(
    createRealTmuxPaneDriver({
      handle: fixture.leftPane,
      stepNames: () => stepNames,
      assertTimeoutMs: REAL_TMUX_ASSERT_TIMEOUT_MS,
      driverLabel: DRIVER_LABEL,
      sendKey: (input) => fixture.sendKey(input),
    }),
  )

  return {
    async launch(spec: ScreenSpec): Promise<void> {
      stepNames = spec.steps
      await fixture.launch({
        steps: spec.steps,
        ...(spec.stopAt !== undefined ? { stopAt: spec.stopAt } : {}),
      })
    },
    leftPane,
    resize(width: number, height: number): Promise<void> {
      return fixture.resize(width, height)
    },
    teardown(): Promise<void> {
      return fixture.dispose()
    },
  }
}

async function build(_meta: ScenarioMeta<readonly DriverName[]>): Promise<ScreenApp> {
  const fixture = await createSinglePaneStepsFixture()
  return createScreenApp(fixture)
}

export const screenDriver: Driver<ScreenApp> = {
  build,
  skip: () => !canRunRealTmux(),
  timeout: REAL_TMUX_TEST_TIMEOUT_MS,
}
