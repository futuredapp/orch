// ---------------------------------------------------------------------------
// TUI overlay — controller → child renderer IPC for banner + view-mode.
// ---------------------------------------------------------------------------
//
// Parent-side write surface: the right-pane controller appends one JSON line
// per snapshot to `<stateDir>/tui-overlay.ndjson`. Each line is a full
// snapshot (no partial updates) so a tailing reader that joins mid-stream
// only needs the most recent line to reconstruct state.
//
// Child-side read surface: the steps-view model tails the file and passes the
// latest `view` + `banner` into the projector. The Ink renderer reads them
// off `StepsViewState`.
//
// Independent of `live-overlay.ts` — that one folds lifecycle events into a
// per-step status overlay; this one carries the controller's UI state (the
// transient banner + the persistent view-mode indicator).

import { z } from 'zod'
import type { Banner, ViewMode } from './step-types.ts'

export interface TuiOverlay {
  readonly view: ViewMode
  readonly banner?: Banner
}

export const DEFAULT_TUI_OVERLAY: TuiOverlay = { view: { mode: 'live' } }

// Wire shape: a single line written per snapshot. `banner: null` is the
// explicit "clear banner" sentinel — distinguished from `banner: undefined`
// (no banner field present, which the parser treats as "no banner").
const ViewModeSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('live') }),
  z.object({ mode: z.literal('replay'), stepName: z.string().min(1) }),
])

const BannerSchema = z.object({
  kind: z.union([z.literal('info'), z.literal('error')]),
  text: z.string(),
  ttlMs: z.number().int().positive().optional(),
  seq: z.number().int().nonnegative(),
})

const TuiOverlaySnapshotSchema = z.object({
  view: ViewModeSchema,
  banner: BannerSchema.nullish(),
})

export type TuiOverlaySnapshot = z.infer<typeof TuiOverlaySnapshotSchema>

export function parseTuiOverlayLine(line: string): TuiOverlay | undefined {
  try {
    const parsed = TuiOverlaySnapshotSchema.parse(JSON.parse(line))
    const banner = parsed.banner ?? undefined
    return banner === undefined ? { view: parsed.view } : { view: parsed.view, banner }
  } catch {
    return undefined
  }
}

export function serializeTuiOverlayLine(overlay: TuiOverlay): string {
  // Always write the full snapshot; readers join mid-stream by reading the
  // last line only.
  const payload: TuiOverlaySnapshot = {
    view: overlay.view,
    banner: overlay.banner ?? null,
  }
  return `${JSON.stringify(payload)}\n`
}
