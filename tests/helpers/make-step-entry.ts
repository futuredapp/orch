import type { RunId, RunState, StepEntry } from '../../src/state/index.ts'

/**
 * Shared factory for v2 StepEntry fixtures.
 *
 * Every state-store-adjacent test used to inline its own `makeEntry` helper.
 * Phase 6 bumps the schema to v2 (adding `validations` and optional
 * `preRunSnapshot`), so a single factory makes future bumps mechanical.
 */
export function makeStepEntry(overrides: Partial<StepEntry> = {}): StepEntry {
  return {
    name: 'step-a',
    value: { result: 'ok' },
    startedAt: 1000,
    endedAt: 2000,
    artifacts: [],
    validations: [],
    ...overrides,
  }
}

/**
 * Shared factory for v2 RunState fixtures. Tests that assemble states by
 * hand (rather than via `FileStateStore.saveStep`) call this.
 */
export function makeRunState(overrides: Partial<RunState> = {}): RunState {
  return {
    schemaVersion: 2,
    id: 'r-2026-04-10-000001' as RunId,
    status: 'running',
    steps: {},
    ...overrides,
  }
}
