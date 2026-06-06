// Local StepEntry/RunState factories for the `model/projector` category — pure
// `projectStepsView` / `applySubworkflowEvent` tests, no Ink, no tmux. These are
// copies of `tests/helpers/make-step-entry.ts` (the old projector tests' source);
// they are re-provided locally rather than imported across the tree boundary
// (CLAUDE.md: tests-new never imports from tests/). The full D13 move of
// make-step-entry to `tests-new/_support/` lands when the state tests relocate
// (U10–U13); until then the old tree keeps its own copy and this is the new one.

import type { RunId, RunState, StepEntry } from '../../../src/state/index.ts'

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

export function makeRunState(overrides: Partial<RunState> = {}): RunState {
  return {
    schemaVersion: 5,
    id: 'r-2026-04-10-458000-q8' as RunId,
    status: 'running',
    startedAt: 0,
    steps: {},
    ...overrides,
  }
}
