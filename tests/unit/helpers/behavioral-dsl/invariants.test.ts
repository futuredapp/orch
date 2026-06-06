// MIGRATED → tests-new/unit/support/behavioral-dsl/invariants.test.ts (parent U13) — relocated verbatim (import paths only); kept skipped on disk (D2).
// Unit coverage for `runInvariantContract` and the outcome matchers it
// composes. Each test builds a synthetic `LifecycleSnapshot` and asserts
// against the violations the contract reports.

import { describe, expect, it } from 'bun:test'
import {
  runInvariantContract,
  type ScenarioTag,
} from '../../../helpers/behavioral-dsl/internal/invariants.ts'
import type { LifecycleSnapshot } from '../../../helpers/behavioral-dsl/internal/snapshot.ts'
import {
  exitedNormally,
  noOrphanChildren,
  stepArtifactsIntact,
  terminalRestoredCleanly,
  tmuxIsTornDown,
  withinMs,
} from '../../../helpers/behavioral-dsl/outcome-matchers.ts'
import { hasStatus } from '../../../helpers/behavioral-dsl/workflow-matchers.ts'

function baseSnapshot(overrides: Partial<LifecycleSnapshot> = {}): LifecycleSnapshot {
  return {
    orchAlive: false,
    orchExit: { code: 0, signal: null },
    tmuxSessionExists: false,
    tmuxServerExists: false,
    panesAlive: [],
    leftPaneText: '',
    rightPaneText: '',
    leftPaneFocused: false,
    rightPaneFocused: false,
    stateStatus: 'completed',
    stepStatuses: {},
    perStepFilesIntact: {},
    stdoutAltScreen: { enters: 1, exits: 1 },
    stdoutMouseTracking: { ons: 0, offs: 0 },
    orphanChildren: [],
    capturedAtMs: 1000,
    orchAliveDurationMs: 500,
    ...overrides,
  }
}

describe.skip('exitedNormally()', () => {
  it('matches when orch exited with code 0', () => {
    const r = exitedNormally()(baseSnapshot())
    expect(r.matched).toBe(true)
  })

  it('matches when orch died via a documented signal (SIGINT)', () => {
    const r = exitedNormally()(baseSnapshot({ orchExit: { code: 130, signal: 'SIGINT' } }))
    expect(r.matched).toBe(true)
  })

  it('fails when orch is still alive', () => {
    const r = exitedNormally()(baseSnapshot({ orchAlive: true, orchExit: null }))
    expect(r.matched).toBe(false)
    expect(r.message).toMatch(/still alive/)
  })

  it('fails with the actual code in the message for an undocumented non-zero exit', () => {
    const r = exitedNormally()(baseSnapshot({ orchExit: { code: 137, signal: null } }))
    expect(r.matched).toBe(false)
    expect(r.message).toMatch(/code=137/)
  })
})

describe.skip('tmuxIsTornDown()', () => {
  it('matches when both tmux server and session are gone', () => {
    expect(tmuxIsTornDown()(baseSnapshot()).matched).toBe(true)
  })

  it('fails when the tmux server is still up', () => {
    const r = tmuxIsTornDown()(baseSnapshot({ tmuxServerExists: true, tmuxSessionExists: false }))
    expect(r.matched).toBe(false)
    expect(r.message).toMatch(/tmuxServerExists=true/)
  })
})

describe.skip('terminalRestoredCleanly()', () => {
  it('matches when enters===exits AND ons===offs', () => {
    expect(
      terminalRestoredCleanly()(
        baseSnapshot({
          stdoutAltScreen: { enters: 3, exits: 3 },
          stdoutMouseTracking: { ons: 2, offs: 2 },
        }),
      ).matched,
    ).toBe(true)
  })

  it('fails with both pair counts in the error message when unbalanced', () => {
    const r = terminalRestoredCleanly()(
      baseSnapshot({
        stdoutAltScreen: { enters: 3, exits: 2 },
        stdoutMouseTracking: { ons: 1, offs: 0 },
      }),
    )
    expect(r.matched).toBe(false)
    expect(r.message).toMatch(/enters=3/)
    expect(r.message).toMatch(/exits=2/)
    expect(r.message).toMatch(/ons=1/)
    expect(r.message).toMatch(/offs=0/)
  })
})

describe.skip('noOrphanChildren()', () => {
  it('matches when no orphans were swept', () => {
    expect(noOrphanChildren()(baseSnapshot()).matched).toBe(true)
  })

  it('fails with the orphan list in the message', () => {
    const r = noOrphanChildren()(
      baseSnapshot({
        orphanChildren: [{ pid: 42, ppid: 17, command: 'sleep 9999' }],
      }),
    )
    expect(r.matched).toBe(false)
    expect(r.message).toMatch(/42/)
    expect(r.message).toMatch(/sleep 9999/)
  })
})

describe.skip('stepArtifactsIntact()', () => {
  it('matches when every per-step file is intact', () => {
    expect(
      stepArtifactsIntact()(baseSnapshot({ perStepFilesIntact: { plan: true, exec: true } }))
        .matched,
    ).toBe(true)
  })

  it('fails with the names of truncated steps', () => {
    const r = stepArtifactsIntact()(
      baseSnapshot({ perStepFilesIntact: { plan: true, exec: false } }),
    )
    expect(r.matched).toBe(false)
    expect(r.message).toMatch(/exec/)
  })
})

describe.skip('withinMs', () => {
  it('returns a polling budget for the given timeout', () => {
    expect(withinMs(2_000)).toEqual({ timeoutMs: 2_000 })
  })

  it('rejects non-positive values', () => {
    expect(() => withinMs(0)).toThrow('positive finite millisecond count')
    expect(() => withinMs(-1)).toThrow('positive finite millisecond count')
  })
})

describe.skip('runInvariantContract', () => {
  it('returns an empty violation list when every matcher passes', () => {
    const violations = runInvariantContract(baseSnapshot(), 'signal-sigint')
    expect(violations).toEqual([])
  })

  it('names each unsatisfied matcher in the violation list', () => {
    const snap = baseSnapshot({
      orchAlive: true,
      orchExit: null,
      tmuxSessionExists: true,
      tmuxServerExists: true,
    })
    const violations = runInvariantContract(snap, 'signal-sigint')

    const matchers = violations.map((v) => v.matcher)
    expect(matchers).toContain('exitedNormally')
    expect(matchers).toContain('tmuxIsTornDown')
  })

  it('evaluates the pane-q-during-run contract row with exitedNormally + tmuxIsTornDown', () => {
    // Post-§2.1 fix: `hasStatus('cancelled')` is intentionally NOT part of
    // this row (matches the `signal-sigint` row — the SIGINT/quit handler
    // does not flush state.json, tracked separately under U7). A still-alive
    // orch with the tmux session up violates both remaining matchers.
    const snap = baseSnapshot({
      stateStatus: 'running',
      orchAlive: true,
      orchExit: null,
      tmuxSessionExists: true,
      tmuxServerExists: true,
    })
    const violations = runInvariantContract(snap, 'pane-q-during-run')

    expect(violations.length).toBeGreaterThan(0)
    const matchers = violations.map((v) => v.matcher)
    expect(matchers).toContain('exitedNormally')
    expect(matchers).toContain('tmuxIsTornDown')
    expect(matchers).not.toContain('hasStatus("cancelled")')
  })

  it('returns no violations for pane-q-during-run when orch has cleanly torn down', () => {
    // stateStatus is irrelevant to this row post-fix; only orch exit + tmux
    // teardown matter.
    const violations = runInvariantContract(
      baseSnapshot({
        orchAlive: false,
        orchExit: { code: 130, signal: 'SIGINT' },
        tmuxSessionExists: false,
        tmuxServerExists: false,
      }),
      'pane-q-during-run',
    )
    expect(violations).toEqual([])
  })

  it('throws on an unknown scenario tag (programming error)', () => {
    expect(() => runInvariantContract(baseSnapshot(), 'no-such' as ScenarioTag)).toThrow(
      'unknown scenario tag',
    )
  })

  it('honors hasStatus("cancelled") as a workflow matcher when matched in isolation', () => {
    expect(hasStatus('cancelled')(baseSnapshot({ stateStatus: 'cancelled' })).matched).toBe(true)
    expect(hasStatus('cancelled')(baseSnapshot({ stateStatus: 'running' })).matched).toBe(false)
  })
})
