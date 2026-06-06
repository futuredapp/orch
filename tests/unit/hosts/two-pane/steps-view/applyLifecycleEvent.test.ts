// MIGRATED → tests-new/unit/hosts/two-pane/steps-view/applyLifecycleEvent.test.ts (parent U14) — demote-relocated (pure logic); kept skipped on disk (D2).
// Unit tests for `applyLifecycleEvent` — the per-line fold the model uses to
// keep its overlay in sync with the tail of `lifecycle.ndjson`.
//
// Mutations are direct — the projector reads from a `Map<string, LiveOverlay>`
// the host loop owns; tests just simulate the loop calling `applyLifecycleEvent`
// for each line.

import { describe, expect, it } from 'bun:test'
import {
  applyLifecycleEvent,
  type LiveOverlay,
} from '../../../../../src/hosts/two-pane/steps-view/index.ts'

describe.skip('applyLifecycleEvent', () => {
  it('records a step:start as running with startedAt and the supplied mode', () => {
    const overlay = new Map<string, LiveOverlay>()

    applyLifecycleEvent(overlay, { type: 'step:start', stepName: 'plan', mode: 'autonomous' }, 1000)

    expect(overlay.get('plan')).toEqual({
      status: 'running',
      mode: 'autonomous',
      startedAt: 1000,
    })
  })

  it('records a step:start with mode=interactive as status interactive', () => {
    const overlay = new Map<string, LiveOverlay>()

    applyLifecycleEvent(overlay, { type: 'step:start', stepName: 'work', mode: 'interactive' }, 50)

    expect(overlay.get('work')).toEqual({
      status: 'interactive',
      mode: 'interactive',
      startedAt: 50,
    })
  })

  it('preserves subPath and insideParallel metadata for live-only projected rows', () => {
    const overlay = new Map<string, LiveOverlay>()

    applyLifecycleEvent(
      overlay,
      {
        type: 'step:start',
        stepName: 'simple-feature>plan',
        mode: 'autonomous',
        subPath: ['simple-feature'],
        insideParallel: true,
      },
      1000,
    )
    applyLifecycleEvent(overlay, { type: 'step:complete', stepName: 'simple-feature>plan' }, 1200)

    expect(overlay.get('simple-feature>plan')).toEqual({
      status: 'completed',
      mode: 'autonomous',
      subPath: ['simple-feature'],
      insideParallel: true,
      startedAt: 1000,
      endedAt: 1200,
    })
  })

  it('flips to completed on step:complete and preserves the prior mode + startedAt', () => {
    const overlay = new Map<string, LiveOverlay>()
    applyLifecycleEvent(overlay, { type: 'step:start', stepName: 'plan', mode: 'autonomous' }, 100)

    applyLifecycleEvent(overlay, { type: 'step:complete', stepName: 'plan' }, 500)

    expect(overlay.get('plan')).toEqual({
      status: 'completed',
      mode: 'autonomous',
      startedAt: 100,
      endedAt: 500,
    })
  })

  it('flips to failed on step:failed and preserves the prior mode + startedAt', () => {
    const overlay = new Map<string, LiveOverlay>()
    applyLifecycleEvent(overlay, { type: 'step:start', stepName: 'plan' }, 100)

    applyLifecycleEvent(overlay, { type: 'step:failed', stepName: 'plan' }, 700)

    const entry = overlay.get('plan')
    expect(entry?.status).toBe('failed')
    expect(entry?.startedAt).toBe(100)
    expect(entry?.endedAt).toBe(700)
  })

  it('uses subPath metadata on terminal events even when no start event was seen', () => {
    const overlay = new Map<string, LiveOverlay>()

    applyLifecycleEvent(
      overlay,
      {
        type: 'step:complete',
        stepName: 'outer>inner>plan',
        subPath: ['outer', 'inner'],
        insideParallel: true,
      },
      700,
    )

    expect(overlay.get('outer>inner>plan')).toEqual({
      status: 'completed',
      subPath: ['outer', 'inner'],
      insideParallel: true,
      endedAt: 700,
    })
  })

  it('marks step:cached without overwriting previously-set timing fields', () => {
    const overlay = new Map<string, LiveOverlay>()

    applyLifecycleEvent(overlay, { type: 'step:cached', stepName: 'plan' }, 0)

    expect(overlay.get('plan')).toEqual({ status: 'cached' })
  })

  it('ignores events with an unknown type or missing stepName so the projector cannot wedge on bad lifecycle lines', () => {
    const overlay = new Map<string, LiveOverlay>()

    applyLifecycleEvent(overlay, { type: 'totally-unknown', stepName: 'plan' }, 1)
    applyLifecycleEvent(overlay, { type: 'step:start' }, 1)
    applyLifecycleEvent(overlay, { type: 'step:complete', stepName: '' }, 1)

    expect(overlay.size).toBe(0)
  })
})
