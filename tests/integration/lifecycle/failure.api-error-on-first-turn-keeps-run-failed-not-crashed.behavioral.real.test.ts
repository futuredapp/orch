/**
 * Behavioral cell — a clean upstream API error from the CLI on its first turn
 * is a STEP failure, not an executor crash. The run-level status should be
 * `failed` (graceful), not `crashed` (the bucket reserved for orchestrator
 * bugs / unhandled exceptions).
 *
 * Reproduces the real-world bug captured in
 * `/Users/martinsumera/projects/futured/kridla-dabing-ai…/.orch/state/
 *   r-2026-05-21-120031-jw/logs/lifecycle.ndjson`:
 *   {"type":"step:failed","stepName":"slug","error":"API Error: 400 ..."}
 *   {"type":"run-ended","status":"crashed"}                  ← this is the bug
 *
 * `instant-fail` emits the same `{kind:'terminal', type:'error', message}`
 * event ClaudeRunner produces from an API-error envelope
 * (src/runners/claude/claude-runner.ts:106-120 vs.
 *  src/runners/scripted-fake/types.ts:68-74), so the executor takes the
 * identical code path the user hit.
 *
 * Expected today: RED — `src/core/workflow.ts:1237` blanket-catches every
 * thrown StepError and writes `'crashed'`, and `src/state/state-store.ts:81`
 * has no `'failed'` variant yet. Once we agree on the fix, this test is the
 * single source of truth for the new behavior.
 */

import { afterEach, beforeEach, describe, it } from 'bun:test'
import {
  assertPersistedState,
  awaitRunStatus,
  hasRunStatus,
  hasStepFailed,
  launchOrchWorkflow,
  type OrchHandle,
  withinMs,
} from '../../helpers/behavioral-dsl/index.ts'
import { canRunRealTmux } from '../../helpers/real-tmux/fixture.ts'

let handle: OrchHandle | undefined

beforeEach(() => {
  handle = undefined
})

afterEach(async () => {
  if (handle !== undefined) await handle.teardown()
})

describe.skipIf(!canRunRealTmux())(
  'Tier 5 behavioral — clean API error on first turn is a step failure, not a run crash',
  () => {
    it('CLI emits terminal error + non-zero exit → step.failed, run.failed (NOT crashed)', async () => {
      handle = await launchOrchWorkflow('single-agent-step', {
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
