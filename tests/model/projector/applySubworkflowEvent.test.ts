// MIGRATED ← tests/unit/hosts/two-pane/steps-view/applySubworkflowEvent.test.ts (parent U7c)
//
// `model/projector` category: pure fold logic, no Ink, no tmux. Pins full-path
// identity so sibling nested subworkflows with the same leaf name do not share
// status, `insideParallel` preservation, and invalid-event rejection.

import { describe, expect, it } from 'bun:test'
import {
  applySubworkflowEvent,
  type SubworkflowOverlay,
  subworkflowOverlayKey,
} from '../../../src/hosts/two-pane/steps-view/index.ts'

describe('applySubworkflowEvent', () => {
  it('keys sibling nested subworkflows by full subPath, not leaf name', () => {
    const overlay = new Map<string, SubworkflowOverlay>()

    applySubworkflowEvent(
      overlay,
      { type: 'subworkflow:enter', name: 'ship', depth: 2, subPath: ['api', 'ship'] },
      100,
    )
    applySubworkflowEvent(
      overlay,
      { type: 'subworkflow:enter', name: 'ship', depth: 2, subPath: ['web', 'ship'] },
      200,
    )
    applySubworkflowEvent(
      overlay,
      {
        type: 'subworkflow:exit',
        name: 'ship',
        depth: 2,
        subPath: ['api', 'ship'],
        outcome: 'completed',
        durationMs: 50,
      },
      300,
    )

    expect(overlay.get(subworkflowOverlayKey(['api', 'ship']))).toEqual({
      status: 'completed',
      depth: 2,
      subPath: ['api', 'ship'],
      startedAt: 100,
      endedAt: 300,
      durationMs: 50,
    })
    expect(overlay.get(subworkflowOverlayKey(['web', 'ship']))).toEqual({
      status: 'running',
      depth: 2,
      subPath: ['web', 'ship'],
      startedAt: 200,
    })
  })

  it('preserves insideParallel from enter or exit events', () => {
    const overlay = new Map<string, SubworkflowOverlay>()

    applySubworkflowEvent(
      overlay,
      {
        type: 'subworkflow:enter',
        name: 'inner',
        depth: 2,
        subPath: ['outer', 'inner'],
        insideParallel: true,
      },
      100,
    )
    applySubworkflowEvent(
      overlay,
      {
        type: 'subworkflow:exit',
        name: 'inner',
        depth: 2,
        subPath: ['outer', 'inner'],
        outcome: 'failed',
      },
      250,
    )

    expect(overlay.get(subworkflowOverlayKey(['outer', 'inner']))).toEqual({
      status: 'failed',
      depth: 2,
      subPath: ['outer', 'inner'],
      insideParallel: true,
      startedAt: 100,
      endedAt: 250,
    })
  })

  it('rejects invalid subworkflow events without mutating the overlay', () => {
    const overlay = new Map<string, SubworkflowOverlay>()

    applySubworkflowEvent(overlay, { type: 'subworkflow:enter', name: 'ship', depth: 1 }, 1)
    applySubworkflowEvent(
      overlay,
      { type: 'subworkflow:enter', name: 'ship', depth: 2, subPath: ['ship'] },
      1,
    )
    applySubworkflowEvent(
      overlay,
      { type: 'subworkflow:enter', name: 'ship', depth: 1, subPath: ['api'] },
      1,
    )
    applySubworkflowEvent(
      overlay,
      {
        type: 'subworkflow:exit',
        name: 'ship',
        depth: 1,
        subPath: ['ship'],
        outcome: 'nope' as never,
      },
      1,
    )

    expect(overlay.size).toBe(0)
  })
})
