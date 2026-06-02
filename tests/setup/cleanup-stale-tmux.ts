// Pre-suite cleanup of leaked tmux state (test preload).
//
// Wired via `bunfig.toml`'s `[test] preload`, this 3-line shim runs once before
// the suite starts and reaps any leftover reserved-namespace test sockets whose
// owner process is dead. The reaping logic — a prefix-gated, pid-liveness sweep
// that is structurally incapable of naming a production `orch-r-…` server and
// deterministically safe against parallel runs — lives in the importable,
// dependency-injectable `reapStaleTestSockets`.
//
// This file is the ONLY place that invokes the sweep at import time — a
// deliberate, documented exception to the project's no-import-side-effects
// rule, confined here so tests can import the reaper module without triggering
// a real sweep.

import { reapStaleTestSockets } from './reap-test-sockets.ts'

// Best-effort cleanup: a sweep failure must degrade to a warning, never abort
// the whole suite before any test runs (an unhandled rejection in a preload is
// fatal to `bun test`). Per-dir readdir errors are already swallowed inside the
// sweep; this guards an unexpected throw from the kill/remove seams.
await reapStaleTestSockets().catch((err) => {
  console.warn('[cleanup-stale-tmux] stale-socket sweep failed, continuing:', err)
})
