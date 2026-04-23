import type { RunId, RunState, StepEntry } from '../../src/state/index.ts'

/**
 * Shared factory for StepEntry fixtures.
 *
 * Every state-store-adjacent test used to inline its own `makeEntry` helper.
 * A single factory makes schema bumps mechanical.
 */
export function makeStepEntry(overrides: Partial<StepEntry> = {}): StepEntry {
  return {
    name: 'step-a',
    value: { result: 'ok' },
    startedAt: 1000,
    endedAt: 2000,
    artifacts: [],
    validations: [],
    transcriptEventCount: 0,
    transcriptTruncated: false,
    ...overrides,
  }
}

/**
 * Shared factory for current-schema RunState fixtures. Tests that assemble
 * states by hand (rather than via `FileStateStore.saveStep`) call this.
 */
export function makeRunState(overrides: Partial<RunState> = {}): RunState {
  return {
    schemaVersion: 5,
    id: 'r-2026-04-10-000001' as RunId,
    status: 'running',
    startedAt: 0,
    steps: {},
    ...overrides,
  }
}
