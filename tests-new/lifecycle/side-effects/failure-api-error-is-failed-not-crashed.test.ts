/**
 * Relocated (parent U8 / G4) from
 * `tests/integration/lifecycle/failure.api-error-on-first-turn-keeps-run-failed-not-crashed.behavioral.real.test.ts`.
 *
 * Side effect: a clean upstream API error from the CLI on its first turn is a
 * STEP failure, not an executor crash — the run-level status is `failed`
 * (graceful), not `crashed` (the bucket reserved for orchestrator bugs).
 *
 * KD5 — asserted as observed on `main`: the old cell's comment predicted RED
 * (`crashed`), but the source has since been fixed; on current `main` the run is
 * persisted `failed`, which this asserts. U8 changes no source.
 */

import { describe, it } from 'bun:test'
import {
  assertPersistedState,
  awaitRunStatus,
  hasRunStatus,
  hasStepFailed,
  withinMs,
} from '@orch/test/behavioral-dsl/index.ts'
import { tmuxAvailable, withOrchHandle } from './_support.ts'

describe.skipIf(!tmuxAvailable)(
  'side-effects — clean API error on first turn is a step failure, not a run crash',
  () => {
    it('CLI emits terminal error + non-zero exit → step.failed, run.failed (NOT crashed)', async () => {
      await withOrchHandle('single-agent-step', {
        script: {
          work: {
            kind: 'instant-fail',
            message: 'API Error: 400 tools.25.custom.input_schema.type: Field required',
          },
        },
      })

      await awaitRunStatus('failed', { timeoutMs: 10_000 })

      await assertPersistedState(withinMs(5_000), hasRunStatus('failed'), hasStepFailed('work'))
    }, 30_000)
  },
)
