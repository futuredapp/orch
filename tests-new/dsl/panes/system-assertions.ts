// ---------------------------------------------------------------------------
// SystemAssertions — process-level outcomes (exit / teardown / persisted state).
// ---------------------------------------------------------------------------
//
// Only meaningful on the `lifecycle` driver (parent U2). The lifecycle driver
// injects a backend that maps each assertion to the behavioral-dsl outcome
// matchers + persisted-state read. Without a backend (any other driver that
// happened to construct one) the methods throw `notImplemented` — no
// `model`/`screen`/`full-host` path depends on this (K7).

import { notImplemented } from '../not-implemented.ts'

/** A persisted run status the lifecycle driver can assert was written. */
export type PersistedStatus = 'completed' | 'failed' | 'cancelled'

/** The concrete process-level checks, supplied by the lifecycle driver. */
export interface SystemAssertionsBackend {
  exitedNormally(): Promise<void>
  tmuxTornDown(): Promise<void>
  persistedStatus(status: PersistedStatus): Promise<void>
}

export class SystemAssertions {
  constructor(private readonly backend?: SystemAssertionsBackend) {}

  exitedNormally(): Promise<void> {
    return this.backend?.exitedNormally() ?? notImplemented('SystemAssertions.exitedNormally')
  }

  tmuxTornDown(): Promise<void> {
    return this.backend?.tmuxTornDown() ?? notImplemented('SystemAssertions.tmuxTornDown')
  }

  persistedStatus(status: PersistedStatus): Promise<void> {
    return (
      this.backend?.persistedStatus(status) ?? notImplemented('SystemAssertions.persistedStatus')
    )
  }
}
