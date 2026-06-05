// ---------------------------------------------------------------------------
// SystemAssertions — process-level outcomes (exit / teardown / persisted state).
// ---------------------------------------------------------------------------
//
// Only meaningful on the `lifecycle` driver (parent U2). U1 declares the shape
// so `LifecycleApp` in `app-surfaces.ts` typechecks; the bodies throw
// `notImplemented` until the lifecycle driver wires them. No `model`/`tmux-argv`
// path depends on this (K7).

import { notImplemented } from '../not-implemented.ts'

/** A persisted run status the lifecycle driver can assert was written. */
export type PersistedStatus = 'completed' | 'failed' | 'cancelled'

export class SystemAssertions {
  exitedNormally(): Promise<void> {
    return notImplemented('SystemAssertions.exitedNormally')
  }

  tmuxTornDown(): Promise<void> {
    return notImplemented('SystemAssertions.tmuxTornDown')
  }

  persistedStatus(_status: PersistedStatus): Promise<void> {
    return notImplemented('SystemAssertions.persistedStatus')
  }
}
