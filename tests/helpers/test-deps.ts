// ---------------------------------------------------------------------------
// Test-only defaults for the WorkflowDeps fields that tests rarely care about.
// ---------------------------------------------------------------------------
//
// Each test constructs its own `WorkflowDeps` to keep the wiring explicit, but
// pure boilerplate (a `PromptService` for tests that don't run `ask()`, the
// `interactivity` axis) can live here so test files don't track every new
// required field. Spread `defaultPromptDeps()` over the per-test deps object;
// override either field in the spread when the test cares.

import { FakePromptService } from '../../src/services/prompt/index.ts'

export interface DefaultPromptDeps {
  readonly promptService: FakePromptService
  readonly interactivity: 'interactive' | 'noninteractive'
}

export function defaultPromptDeps(
  overrides: { readonly interactivity?: 'interactive' | 'noninteractive' } = {},
): DefaultPromptDeps {
  return {
    promptService: new FakePromptService(),
    interactivity: overrides.interactivity ?? 'interactive',
  }
}
