// ---------------------------------------------------------------------------
// Driver registry — add a driver with a new file + one line, no central switch.
// ---------------------------------------------------------------------------
//
// All hard-won real-tmux predictability rules (unique socket per run, timeout
// constants, hook-signal + liveness backstop, server reaping, puppet self-reap,
// poll-and-resend) belong INSIDE each driver's `build`/`teardown` (parent U2),
// not on scenario authors. U1 ships the `model` driver live; U2 lands `screen`,
// `full-host:fake-agent`, and `lifecycle`; U3 lands `full-host:recorded-agent`
// and `full-host:real-agent` — so the `satisfies` constraint keeps the
// `DriverName` union complete with no stubs remaining.

import type { AppBase, DriverName } from '../app-surfaces.ts'
import type { ScenarioMeta } from '../scenario.ts'
import { fullHostFakeAgentDriver } from './full-host-fake-agent-driver.ts'
import { fullHostRealAgentDriver } from './full-host-real-agent-driver.ts'
import { fullHostRecordedAgentDriver } from './full-host-recorded-agent-driver.ts'
import { lifecycleDriver } from './lifecycle-driver.ts'
import { modelDriver } from './model-driver.ts'
import { screenDriver } from './screen-driver.ts'

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
  'full-host:recorded-agent': fullHostRecordedAgentDriver,
  'full-host:real-agent': fullHostRealAgentDriver,
  lifecycle: lifecycleDriver,
} satisfies Record<DriverName, Driver<AppBase>>
