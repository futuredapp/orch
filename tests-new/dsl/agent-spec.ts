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
//   fromCassette(f) → replay a recorded normalised-event cassette (parent §9.6)
//
// These are plain data factories — no driver, no tmux, no I/O. The real-runner
// `claudeAgent` / `codexAgent` specs (parent §9.7) are added by U3.2.

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

/**
 * Replay a recorded normalised-event cassette through the fake-agent engine
 * (parent §9.6). `file` resolves relative to
 * `tests-new/full-host/recorded-agent/cassettes/`.
 */
export interface CassetteSpec {
  readonly kind: 'cassette'
  readonly file: string
}

/**
 * Put a REAL `ClaudeRunner` / `CodexRunner` in the agent slot (parent §9.7).
 * The swap of `runner` is the only difference from the static fake path — it is
 * the promotion, not a copy-paste. Gated; reachable only by path (D8).
 */
export interface RealAgentSpec {
  readonly kind: 'real-agent'
  readonly runner: 'claude' | 'codex'
  readonly prompt: string
}

export type AgentSpec = EmitsSpec | LiveSpec | HoldsOpenSpec | CassetteSpec | RealAgentSpec

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

/**
 * Replay the recorded cassette `file` (resolved under the recorded-agent
 * `cassettes/` dir) through the fake-agent engine — realistic events, captured
 * once, replayed deterministically with no CLI (parent §9.6).
 */
export function fromCassette(file: string): CassetteSpec {
  return { kind: 'cassette', file }
}

/** Put the real `ClaudeRunner` in the agent slot with `prompt` (parent §9.7). */
export function claudeAgent(prompt: string): RealAgentSpec {
  return { kind: 'real-agent', runner: 'claude', prompt }
}

/** Put the real `CodexRunner` in the agent slot with `prompt` (parent §9.7). */
export function codexAgent(prompt: string): RealAgentSpec {
  return { kind: 'real-agent', runner: 'codex', prompt }
}
