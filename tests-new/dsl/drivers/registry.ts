// ---------------------------------------------------------------------------
// Driver registry — add a driver with a new file + one line, no central switch.
// ---------------------------------------------------------------------------
//
// All hard-won real-tmux predictability rules (unique socket per run, timeout
// constants, hook-signal + liveness backstop, server reaping, puppet self-reap,
// poll-and-resend) belong INSIDE each driver's `build`/`teardown` (parent U2),
// not on scenario authors. U1 ships the `model` driver live; the five tmux/
// agent drivers are `notImplemented` stubs that `skip()` until U2/U3 replace
// them — so the `satisfies` constraint keeps the `DriverName` union complete.

import type { AppBase, DriverName } from '../app-surfaces.ts'
import type { ScenarioMeta } from '../scenario.ts'
import { fullHostFakeAgentDriver } from './full-host-fake-agent-driver.ts'
import { lifecycleDriver } from './lifecycle-driver.ts'
import { modelDriver } from './model-driver.ts'
import { screenDriver } from './screen-driver.ts'
import { makeStubDriver } from './stub-driver.ts'

export interface Driver<App extends AppBase> {
  /** Owns the fixture lifecycle for one scenario case. */
  build(meta: ScenarioMeta<readonly DriverName[]>): Promise<App>
  /** Capability predicate (D8) — `true` means skip on this box. */
  skip(): boolean
  /** Driver-appropriate per-test budget (ms). */
  timeout: number
}

export const DRIVERS = {
  model: modelDriver,
  screen: screenDriver,
  'full-host:fake-agent': fullHostFakeAgentDriver,
  'full-host:recorded-agent': makeStubDriver('full-host:recorded-agent', 'parent U3'),
  'full-host:real-agent': makeStubDriver('full-host:real-agent', 'parent U3'),
  lifecycle: lifecycleDriver,
} satisfies Record<DriverName, Driver<AppBase>>
