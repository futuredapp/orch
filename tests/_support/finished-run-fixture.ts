// ---------------------------------------------------------------------------
// finished-run fixture builder — seed a pre-finished `.orch/state/<runId>/`.
// ---------------------------------------------------------------------------
//
// The gating test infra for the "re-open a finished run" feature (plan U1):
// writes a terminal-status run to disk WITHOUT executing a workflow, so tests
// can drive `orch resume`/`openFinished` against a real `state.json` the same
// way a finished run would have left one. Reused across the read-only-open and
// (later) failed-interactive units.
//
// Status note: persisted `StepEntry` rows carry no per-step status, so the
// projector renders them `completed` (`project-steps-view.ts buildStepRow`).
// This builder therefore models `completed`/`crashed`/`running` cleanly; the
// `failed` view's failed-step representation is a Phase 2 concern and is
// intentionally not synthesized here.

import type { RunId, StateStore, StepEntry } from '../../src/state/index.ts'

export interface FinishedRunStepSpec {
  readonly name: string
  readonly startedAt?: number
  readonly endedAt?: number
  /** Persisted step value (defaults to `null`). */
  readonly value?: unknown
  readonly mode?: 'interactive' | 'autonomous'
}

export interface FinishedRunSpec {
  readonly runId: RunId
  /** Terminal status to stamp once the steps are written. */
  readonly status: 'completed' | 'crashed' | 'running'
  readonly workflowName?: string
  readonly startedAt?: number
  readonly endedAt?: number
  /** Step rows to persist (each rendered `completed` by the projector). */
  readonly steps?: readonly FinishedRunStepSpec[]
}

function toStepEntry(spec: FinishedRunStepSpec, index: number): StepEntry {
  const startedAt = spec.startedAt ?? index * 1_000
  return {
    name: spec.name,
    value: spec.value ?? null,
    startedAt,
    endedAt: spec.endedAt ?? startedAt + 500,
    artifacts: [],
    validations: [],
    transcriptEventCount: 0,
    transcriptTruncated: false,
    ...(spec.mode !== undefined ? { mode: spec.mode } : {}),
  }
}

/**
 * Write a finished (or `running`) run to `store` without executing anything.
 * Returns the seeded `runId`.
 */
export async function writeFinishedRun(store: StateStore, spec: FinishedRunSpec): Promise<RunId> {
  const startedAt = spec.startedAt ?? 1_000
  await store.initRun(spec.runId, {
    workflowName: spec.workflowName ?? 'demo',
    startedAt,
    ...(spec.startedAt !== undefined ? { startedAt: spec.startedAt } : {}),
  })

  const steps = spec.steps ?? []
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    if (step === undefined) continue
    await store.saveStep(spec.runId, toStepEntry(step, i))
  }

  // `running` runs have no `endedAt` — leave the initRun status in place.
  if (spec.status !== 'running') {
    await store.setStatus(spec.runId, spec.status, spec.endedAt ?? startedAt + steps.length * 1_000)
  }

  return spec.runId
}
