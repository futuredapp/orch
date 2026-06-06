// MIGRATED → tests-new/unit/support/behavioral-dsl/pane-matchers.test.ts (parent U13) — relocated verbatim (import paths only); kept skipped on disk (D2).
// Unit coverage for pane / workflow matchers. Each constructor returns
// either a `Matcher` (workflow) or a `PaneMatcherFactory` (pane-content);
// both project over a synthetic `LifecycleSnapshot`.

import { describe, expect, it } from 'bun:test'
import { paneId } from '../../../../src/services/tmux/index.ts'
import type { LifecycleSnapshot } from '../../../helpers/behavioral-dsl/internal/snapshot.ts'
import {
  containsText,
  doesNotContain,
  hasFooterText,
  hasNoLiveOutput,
  isFocused,
  isPaneDead,
  showsInkState,
} from '../../../helpers/behavioral-dsl/pane-matchers.ts'
import {
  hasExitCode,
  hasExitedBySignal,
  hasStatus,
  hasStepStatus,
  isRunningStep,
} from '../../../helpers/behavioral-dsl/workflow-matchers.ts'

function baseSnapshot(overrides: Partial<LifecycleSnapshot> = {}): LifecycleSnapshot {
  return {
    orchAlive: true,
    orchExit: null,
    tmuxSessionExists: true,
    tmuxServerExists: true,
    panesAlive: [
      { id: paneId('%0'), dead: false },
      { id: paneId('%1'), dead: false },
    ],
    leftPaneText: '',
    rightPaneText: '',
    leftPaneFocused: false,
    rightPaneFocused: false,
    stateStatus: 'running',
    stepStatuses: {},
    perStepFilesIntact: {},
    stdoutAltScreen: { enters: 0, exits: 0 },
    stdoutMouseTracking: { ons: 0, offs: 0 },
    orphanChildren: [],
    capturedAtMs: 0,
    orchAliveDurationMs: 0,
    ...overrides,
  }
}

describe.skip('containsText', () => {
  it('matches when the literal substring appears in the bound pane', () => {
    const m = containsText('hello')('left')
    expect(m(baseSnapshot({ leftPaneText: 'say hello world' })).matched).toBe(true)
  })

  it('does not match when the substring is missing', () => {
    const m = containsText('hello')('left')
    expect(m(baseSnapshot({ leftPaneText: 'world' })).matched).toBe(false)
  })

  it('matches a RegExp needle', () => {
    const m = containsText(/h\w+o/)('left')
    expect(m(baseSnapshot({ leftPaneText: 'hello world' })).matched).toBe(true)
  })

  it('binds to the right pane when the factory is called with "right"', () => {
    const m = containsText('agent')('right')
    expect(m(baseSnapshot({ rightPaneText: 'agent is thinking' })).matched).toBe(true)
    expect(m(baseSnapshot({ leftPaneText: 'agent is thinking' })).matched).toBe(false)
  })
})

describe.skip('doesNotContain', () => {
  it('matches when the needle is absent', () => {
    const m = doesNotContain('boom')('left')
    expect(m(baseSnapshot({ leftPaneText: 'everything is fine' })).matched).toBe(true)
  })

  it('surfaces the offending text on failure', () => {
    const m = doesNotContain('boom')('left')
    const r = m(baseSnapshot({ leftPaneText: 'boom and crash' }))
    expect(r.matched).toBe(false)
    expect(r.message).toMatch(/unexpectedly present/)
  })
})

describe.skip('isFocused', () => {
  it('matches when the bound pane is focused', () => {
    expect(isFocused()('left')(baseSnapshot({ leftPaneFocused: true })).matched).toBe(true)
    expect(isFocused()('right')(baseSnapshot({ rightPaneFocused: true })).matched).toBe(true)
  })

  it('does not match when the bound pane is unfocused', () => {
    expect(isFocused()('left')(baseSnapshot({ leftPaneFocused: false })).matched).toBe(false)
  })
})

describe.skip('showsInkState', () => {
  it('matches the "live" banner pattern in the pane text', () => {
    expect(
      showsInkState('live')('left')(baseSnapshot({ leftPaneText: '▶ live agent' })).matched,
    ).toBe(true)
  })

  it('does not match when the pattern is absent', () => {
    expect(showsInkState('live')('left')(baseSnapshot({ leftPaneText: 'idle' })).matched).toBe(
      false,
    )
  })

  it('matches the "error-banner" pattern for failure summaries', () => {
    expect(
      showsInkState('error-banner')('left')(baseSnapshot({ leftPaneText: '✗ step failed' }))
        .matched,
    ).toBe(true)
  })
})

describe.skip('hasFooterText', () => {
  it('matches when the needle appears in the last few lines of the pane', () => {
    const body = 'line 1\nline 2\nline 3\nline 4\nfooter row'
    expect(hasFooterText('footer')('left')(baseSnapshot({ leftPaneText: body })).matched).toBe(true)
  })

  it('does not match when the needle is in the top half but not the footer', () => {
    const body = `header\n${'line\n'.repeat(20)}footer`
    expect(hasFooterText('header')('left')(baseSnapshot({ leftPaneText: body })).matched).toBe(
      false,
    )
  })
})

describe.skip('hasNoLiveOutput', () => {
  it('matches when the pane text is empty / whitespace only', () => {
    expect(hasNoLiveOutput()('left')(baseSnapshot({ leftPaneText: '   \n  ' })).matched).toBe(true)
  })

  it('does not match when the pane has any content', () => {
    expect(hasNoLiveOutput()('left')(baseSnapshot({ leftPaneText: 'x' })).matched).toBe(false)
  })
})

describe.skip('isPaneDead', () => {
  it('matches when the bound pane reports pane_dead=1', () => {
    const snap = baseSnapshot({
      panesAlive: [
        { id: paneId('%0'), dead: true },
        { id: paneId('%1'), dead: false },
      ],
    })
    expect(isPaneDead()('left')(snap).matched).toBe(true)
    expect(isPaneDead()('right')(snap).matched).toBe(false)
  })
})

describe.skip('workflow matchers', () => {
  it('isRunningStep matches when stateStatus=running and the step entry is unfinalized', () => {
    const snap = baseSnapshot({
      stateStatus: 'running',
      stepStatuses: { plan: 'unknown' },
    })
    expect(isRunningStep('plan')(snap).matched).toBe(true)
  })

  it('isRunningStep does not match when the step has completed', () => {
    const snap = baseSnapshot({
      stateStatus: 'running',
      stepStatuses: { plan: 'completed' },
    })
    expect(isRunningStep('plan')(snap).matched).toBe(false)
  })

  it('hasStatus matches the snapshot stateStatus', () => {
    expect(hasStatus('cancelled')(baseSnapshot({ stateStatus: 'cancelled' })).matched).toBe(true)
    expect(hasStatus('cancelled')(baseSnapshot({ stateStatus: 'running' })).matched).toBe(false)
  })

  it('hasStepStatus matches per-step state', () => {
    const snap = baseSnapshot({ stepStatuses: { plan: 'completed' } })
    expect(hasStepStatus('plan', 'completed')(snap).matched).toBe(true)
    expect(hasStepStatus('plan', 'failed')(snap).matched).toBe(false)
  })

  it('hasExitCode matches a known exit code', () => {
    const snap = baseSnapshot({ orchAlive: false, orchExit: { code: 130, signal: 'SIGINT' } })
    expect(hasExitCode(130)(snap).matched).toBe(true)
    expect(hasExitCode(0)(snap).matched).toBe(false)
  })

  it('hasExitedBySignal matches the latched signal', () => {
    const snap = baseSnapshot({ orchAlive: false, orchExit: { code: 130, signal: 'SIGINT' } })
    expect(hasExitedBySignal('SIGINT')(snap).matched).toBe(true)
    expect(hasExitedBySignal('SIGTERM')(snap).matched).toBe(false)
  })
})
