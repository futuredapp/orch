// ---------------------------------------------------------------------------
// AgentSpec — how a scenario declares what its agent does, fidelity-independent.
// ---------------------------------------------------------------------------
//
// The full-host / lifecycle drivers interpret these specs against their agent
// slot (parent §9.5/§9.8). A scenario writes `agent: emits(...)` / `live()` /
// `holdsOpen()`; the driver maps each to a concrete fake:
//
//   emits(...texts) → a static `FakeRunner.script({ events })` per step
//   live()          → the `scriptedFake` subprocess puppet, driven step-by-step
//   holdsOpen()     → a step that stays running until the test ends it
//
// These are plain data factories — no driver, no tmux, no I/O. The cassette-
// backed `fromCassette` / `claudeAgent` specs are parent U3.

/** Static agent: emit each text as an autonomous transcript line, then finish. */
export interface EmitsSpec {
  readonly kind: 'emits'
  readonly texts: readonly string[]
}

/** Live-driven agent: a scriptedFake puppet the test advances via `app.agent`. */
export interface LiveSpec {
  readonly kind: 'live'
}

/** A step that holds open (stays running) until the run is torn down/cancelled. */
export interface HoldsOpenSpec {
  readonly kind: 'holds-open'
}

export type AgentSpec = EmitsSpec | LiveSpec | HoldsOpenSpec

/** Static agent scripted to emit `texts` as autonomous transcript lines. */
export function emits(...texts: readonly string[]): EmitsSpec {
  return { kind: 'emits', texts }
}

/** Opt into the live-driven scriptedFake submode (requires `liveDriven: true`). */
export function live(): LiveSpec {
  return { kind: 'live' }
}

/** A step that stays running until the test cancels/tears down the run. */
export function holdsOpen(): HoldsOpenSpec {
  return { kind: 'holds-open' }
}
