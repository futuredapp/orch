// Wire-format tests for the parent → child TUI overlay IPC channel.
//
// One JSON line per snapshot, written by the controller, tailed by the model.
// `banner: null` is the explicit "clear banner" sentinel; the parser maps it
// onto an undefined `banner` field on the in-memory shape so downstream callers
// can use `banner === undefined` as the single absent-banner test.

import { describe, expect, it } from 'bun:test'
import {
  parseTuiOverlayLine,
  serializeTuiOverlayLine,
  type TuiOverlay,
} from '../../../../src/hosts/two-pane/steps-view/index.ts'

describe('parseTuiOverlayLine', () => {
  it('parses a live view-mode snapshot with no banner', () => {
    const parsed = parseTuiOverlayLine(JSON.stringify({ view: { mode: 'live' } }))

    expect(parsed).toEqual({ view: { mode: 'live' } })
  })

  it('parses a replay view-mode snapshot with the stepName preserved', () => {
    const parsed = parseTuiOverlayLine(
      JSON.stringify({ view: { mode: 'replay', stepName: 'plan' } }),
    )

    expect(parsed).toEqual({ view: { mode: 'replay', stepName: 'plan' } })
  })

  it('parses an info banner snapshot with seq and ttlMs preserved', () => {
    const parsed = parseTuiOverlayLine(
      JSON.stringify({
        view: { mode: 'live' },
        banner: { kind: 'info', text: 'step plan running', ttlMs: 4000, seq: 7 },
      }),
    )

    expect(parsed).toEqual({
      view: { mode: 'live' },
      banner: { kind: 'info', text: 'step plan running', ttlMs: 4000, seq: 7 },
    })
  })

  it('parses an error banner snapshot without ttlMs', () => {
    const parsed = parseTuiOverlayLine(
      JSON.stringify({
        view: { mode: 'live' },
        banner: { kind: 'error', text: 'resume failed', seq: 2 },
      }),
    )

    expect(parsed).toEqual({
      view: { mode: 'live' },
      banner: { kind: 'error', text: 'resume failed', seq: 2 },
    })
  })

  it('treats banner:null as "no banner" (explicit clear sentinel)', () => {
    const parsed = parseTuiOverlayLine(JSON.stringify({ view: { mode: 'live' }, banner: null }))

    expect(parsed).toEqual({ view: { mode: 'live' } })
  })

  it('returns undefined on malformed JSON', () => {
    expect(parseTuiOverlayLine('{not json')).toBeUndefined()
  })

  it('returns undefined when view is missing', () => {
    expect(parseTuiOverlayLine(JSON.stringify({ banner: null }))).toBeUndefined()
  })

  it('returns undefined when banner has a negative seq', () => {
    expect(
      parseTuiOverlayLine(
        JSON.stringify({
          view: { mode: 'live' },
          banner: { kind: 'info', text: 'x', seq: -1 },
        }),
      ),
    ).toBeUndefined()
  })

  it('returns undefined for unknown banner kinds', () => {
    expect(
      parseTuiOverlayLine(
        JSON.stringify({
          view: { mode: 'live' },
          banner: { kind: 'warn', text: 'x', seq: 1 },
        }),
      ),
    ).toBeUndefined()
  })
})

describe('serializeTuiOverlayLine', () => {
  it('writes banner:null when banner is undefined (explicit clear sentinel)', () => {
    const overlay: TuiOverlay = { view: { mode: 'live' } }

    const line = serializeTuiOverlayLine(overlay)

    expect(line.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(line) as Record<string, unknown>
    expect(parsed).toEqual({ view: { mode: 'live' }, banner: null })
  })

  it('round-trips a full banner snapshot through parse', () => {
    const overlay: TuiOverlay = {
      view: { mode: 'replay', stepName: 'plan' },
      banner: { kind: 'error', text: 'oops', seq: 3 },
    }

    const line = serializeTuiOverlayLine(overlay)

    expect(parseTuiOverlayLine(line.trimEnd())).toEqual(overlay)
  })
})
