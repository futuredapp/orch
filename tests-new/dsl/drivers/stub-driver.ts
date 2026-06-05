// A placeholder driver for fidelities that land in a later parent phase. Its
// `skip()` returns `true`, so a scenario that lists it is SKIPPED at runtime
// rather than crashing the suite; `build()` throws a clear message if anything
// bypasses the skip. Each stub is replaced by a real driver in U2/U3.

import type { AppBase, DriverName } from '../app-surfaces.ts'
import { notImplemented } from '../not-implemented.ts'
import type { ScenarioMeta } from '../scenario.ts'
import type { Driver } from './registry.ts'

export function makeStubDriver(name: DriverName, landsIn: string): Driver<AppBase> {
  return {
    build(_meta: ScenarioMeta<readonly DriverName[]>): Promise<AppBase> {
      return notImplemented(`the '${name}' driver (lands in ${landsIn})`)
    },
    skip: () => true,
    timeout: 5_000,
  }
}
