// Regression test for the right-pane-controller wiring: the `HostFactoryInputs`
// contract must include `stateStore`, otherwise the two-pane factory has no
// way to thread it into `createTmuxHost` and Enter-to-inspect intents are
// silently dropped (a real bug we hit on 2026-05-06).

import { describe, expect, it } from 'bun:test'
import type { HostFactoryInputs, RegisterBuiltinHostsDeps } from '../../../src/hosts/index.ts'
import { createNullSessionLogger } from '../../../src/observability/index.ts'
import { toClaudeTranscriptLines } from '../../../src/runners/index.ts'
import { FakeClock } from '../../../src/services/index.ts'
import {
  type PersistedWorkflowArgs,
  type RunId,
  type RunState,
  type StateStore,
  runId as toRunId,
} from '../../../src/state/index.ts'

function makeNoopStateStore(rid: RunId): StateStore {
  const empty: RunState = {
    schemaVersion: 5,
    id: rid,
    status: 'running',
    workflowName: 'demo',
    startedAt: 0,
    steps: {},
  }
  return {
    loadRun: async () => empty,
    saveStep: async () => {
      throw new Error('not implemented')
    },
    initRun: async () => {
      throw new Error('not implemented')
    },
    setStatus: async () => {
      throw new Error('not implemented')
    },
    setArgs: async (_rid: RunId, _args: PersistedWorkflowArgs) => {
      throw new Error('not implemented')
    },
  }
}

describe('HostFactoryInputs contract', () => {
  it('accepts a `stateStore` field — required by the two-pane right-pane controller', () => {
    const rid = toRunId('r-2026-05-06-200000-a1')
    // Compile-time guarantee: this assignment fails to type-check if
    // `stateStore` is not part of `HostFactoryInputs`. The runtime check
    // is a redundancy guard — the value of this test is the field's
    // presence in the type.
    const inputs: HostFactoryInputs = {
      runId: rid,
      workflowName: 'demo',
      stdout: process.stdout,
      stderr: process.stderr,
      clock: new FakeClock(0),
      logger: createNullSessionLogger({ runId: rid }),
      stateStore: makeNoopStateStore(rid),
    }

    expect(inputs.stateStore).toBeDefined()
  })
})

describe('RegisterBuiltinHostsDeps.tmuxOverrides contract', () => {
  it('accepts a `transcriptRenderer` field — required for formatted ⏎ inspect on completed steps', () => {
    // Compile-time guarantee: this assignment fails to type-check if
    // `transcriptRenderer` is not part of `TmuxHostOptions` (and thus the
    // `tmuxOverrides` Omit). Mirrors the `stateStore` regression test
    // above. The value of this test is the field's presence in the type.
    const deps: RegisterBuiltinHostsDeps = {
      processService: {} as unknown as RegisterBuiltinHostsDeps['processService'],
      format: 'text',
      tmuxOverrides: {
        transcriptRenderer: toClaudeTranscriptLines,
      },
    }

    expect(deps.tmuxOverrides?.transcriptRenderer).toBe(toClaudeTranscriptLines)
  })
})
