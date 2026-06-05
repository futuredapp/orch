// triage: keep — Tier 2 banner rendering coverage.
//
// Info and error banners must surface in the rendered frame. Info banners
// auto-clear after their TTL (Tier 2 covers the renderer's *visibility*;
// TTL timing is owned by the controller, not the view); error banners
// persist until `dismiss-banner` clears the slot. Pins the projection: if
// `state.banner === undefined`, no banner row appears.

import { describe, expect, it } from 'bun:test'
import { renderToString } from 'ink'
import type { StepsViewState } from '../../../../../src/hosts/two-pane/steps-view/index.ts'
import { StepsView } from '../../../../../src/hosts/two-pane/steps-view/index.ts'
import { stripAnsi } from '../../../../../src/observability/index.ts'

const NOOP = (): void => {}
const NOW = 5_000

function withBanner(banner: StepsViewState['banner']): StepsViewState {
  const state: StepsViewState = {
    status: 'live',
    run: { runId: 'r-2026-05-12-100000-aa', workflowName: 'demo', startedAt: 0 },
    steps: [
      {
        kind: 'agent',
        mode: 'autonomous',
        status: 'running',
        name: 'plan',
        startedAt: 1_000,
      },
    ],
    view: { mode: 'live' },
    ...(banner !== undefined ? { banner } : {}),
  }
  return state
}

// MIGRATED → tests-new/model/banner--info-and-error-paint.test.ts
//          + tests-new/screen/banner--paint-bytes.test.ts  (parent U5b)
describe.skip('<StepsView> banner rendering', () => {
  it('info banner text appears in the frame', () => {
    const frame = stripAnsi(
      renderToString(
        <StepsView
          state={withBanner({ kind: 'info', text: 'step plan complete', seq: 1 })}
          onIntent={NOOP}
          now={() => NOW}
        />,
        { columns: 110 },
      ),
    )
    expect(frame).toContain('step plan complete')
  })

  it('error banner text appears in the frame', () => {
    const frame = stripAnsi(
      renderToString(
        <StepsView
          state={withBanner({ kind: 'error', text: 'step plan failed', seq: 1 })}
          onIntent={NOOP}
          now={() => NOW}
        />,
        { columns: 110 },
      ),
    )
    expect(frame).toContain('step plan failed')
  })

  it('no banner field → no banner row in the frame', () => {
    const frame = stripAnsi(
      renderToString(<StepsView state={withBanner(undefined)} onIntent={NOOP} now={() => NOW} />, {
        columns: 110,
      }),
    )
    expect(frame).not.toContain('plan complete')
    expect(frame).not.toContain('plan failed')
  })
})
