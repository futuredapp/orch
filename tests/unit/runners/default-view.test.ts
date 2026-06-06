// MIGRATED → tests-new/unit/runners/default-view.test.ts (parent U11) — relocated verbatim (import paths only); kept skipped on disk (D2).
// Phase B — each runner adapter ships a defaultView so step.define can stay
// terse. The shape is { kind: ViewKind; pane: PaneRole }; here we verify the
// built-in adapters expose it with the expected values.

import { describe, expect, it } from 'bun:test'
import { claude } from '../../../src/runners/claude/index.ts'
import { codex } from '../../../src/runners/codex/index.ts'
import { FakeRunner } from '../../../src/runners/fake/index.ts'
import { FakeFsService, FakeProcessService } from '../../../src/services/index.ts'

describe.skip('runner defaultView', () => {
  it('claude ships { kind: transcript, pane: right }', () => {
    const runner = claude()

    expect(runner.defaultView).toEqual({ kind: 'transcript', pane: 'right' })
  })

  it('codex ships { kind: transcript, pane: right }', () => {
    const fs = new FakeFsService()
    const ps = new FakeProcessService()
    const runner = codex({}, { fs, ps })

    expect(runner.defaultView).toEqual({ kind: 'transcript', pane: 'right' })
  })

  it('FakeRunner ships { kind: transcript, pane: right } so tests inherit the shape', () => {
    const runner = new FakeRunner(new FakeProcessService())

    expect(runner.defaultView).toEqual({ kind: 'transcript', pane: 'right' })
  })
})
