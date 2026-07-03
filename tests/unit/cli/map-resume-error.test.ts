// Regression tests pinning the exit-code contract of `mapResumeError`.
//
// `mapResumeError` is a pure classifier: it maps a thrown error to the process
// exit code that `orch resume`/`orch retry` surface to callers. Scripts and CI
// depend on that contract, so every branch gets a direct assertion against the
// real `EXIT` constants (never a hardcoded 1/2/3) so a future renumbering keeps
// the test honest.
//
// Per `testing-strategy.md` rule 3: no mocks. `mapResumeError` is pure and every
// error is a plain value class, so each case constructs a real instance and calls
// the function directly.

import { describe, expect, it } from 'bun:test'
import { ZodError } from 'zod'
import { mapResumeError } from '../../../src/cli/commands/resume-execution.ts'
import { EXIT } from '../../../src/cli/main.ts'
import {
  ParallelError,
  ResumeError,
  RunNotFoundError,
  SchemaValidationError,
  StepError,
  type StepName,
  ViewResolutionError,
} from '../../../src/core/index.ts'
import { HostUnavailableError } from '../../../src/hosts/index.ts'
import { path } from '../../../src/services/index.ts'
import { type RunId, StateCorruptionError } from '../../../src/state/index.ts'

const RUN_ID = 'r-2026-07-04-000001-aa' as RunId
const STEP = 'plan' as StepName

interface MappingCase {
  readonly summary: string
  readonly make: () => unknown
  readonly code: number
}

const MAPPING_CASES: readonly MappingCase[] = [
  {
    summary: 'maps RunNotFoundError to the CANNOT_RESUME exit code',
    make: () => new RunNotFoundError(RUN_ID),
    code: EXIT.CANNOT_RESUME,
  },
  {
    summary: 'maps ResumeError to the CANNOT_RESUME exit code',
    make: () => new ResumeError(RUN_ID, 'completed'),
    code: EXIT.CANNOT_RESUME,
  },
  {
    summary: 'maps ViewResolutionError to the CONFIG_ERROR exit code',
    make: () => new ViewResolutionError('cannot resolve view'),
    code: EXIT.CONFIG_ERROR,
  },
  {
    summary: 'maps StateCorruptionError to the CONFIG_ERROR exit code',
    make: () => new StateCorruptionError('state file is corrupt', path('/tmp/state.json'), []),
    code: EXIT.CONFIG_ERROR,
  },
  {
    summary: 'maps StepError to the STEP_FAILURE exit code',
    make: () => new StepError(STEP, 1, 'boom'),
    code: EXIT.STEP_FAILURE,
  },
  {
    summary: 'maps SchemaValidationError to the STEP_FAILURE exit code',
    make: () => new SchemaValidationError(STEP, new ZodError([])),
    code: EXIT.STEP_FAILURE,
  },
  {
    summary: 'maps ParallelError to the STEP_FAILURE exit code',
    make: () => new ParallelError([{ status: 'error', error: new Error('branch') }]),
    code: EXIT.STEP_FAILURE,
  },
  {
    summary: 'maps HostUnavailableError to the STEP_FAILURE exit code',
    make: () => new HostUnavailableError('host is down', new Error('cause')),
    code: EXIT.STEP_FAILURE,
  },
]

describe('mapResumeError exit-code contract', () => {
  for (const testCase of MAPPING_CASES) {
    it(testCase.summary, () => {
      const err = testCase.make()

      const result = mapResumeError(err)

      expect(result?.code).toBe(testCase.code)
    })
  }

  it('returns undefined for an unrecognized error so the caller can fall through to its default', () => {
    const err = new Error('unmapped')

    const result = mapResumeError(err)

    expect(result).toBeUndefined()
  })

  it('carries the original error message through as the reason for a mapped error', () => {
    const err = new ViewResolutionError('cannot resolve view "steps"')

    const result = mapResumeError(err)

    expect(result?.reason).toBe('cannot resolve view "steps"')
  })
})
