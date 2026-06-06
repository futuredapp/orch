// ---------------------------------------------------------------------------
// ModelHarness — the React host the `model` driver renders.
// ---------------------------------------------------------------------------
//
// Wraps the real `<StepsView>` in a thin host that holds the bits a live `orch`
// run would hold in the controller: the right-pane `view` mode (updated from the
// same `StepsViewIntent`s a real keypress produces) and the single-slot banner
// (injected via `emitBanner`, auto-cleared on a VIRTUAL clock so banner-TTL is
// deterministic — D-P2). The genuine logic under test (selection tracking
// `view`, snap-to-live, scroll, banner auto-dismiss) runs against the real
// component + hooks; only the synthetic state and the clock are the harness's.

import { createElement, type ReactElement, useCallback, useEffect, useState } from 'react'
import type {
  Banner,
  StepsViewIntent,
  StepsViewState,
  ViewMode,
} from '../../../src/hosts/two-pane/steps-view/index.ts'
import { StepsView } from '../../../src/hosts/two-pane/steps-view/index.ts'

const LIVE_VIEW: ViewMode = { mode: 'live' }

/** A scheduled auto-dismiss, fired by the virtual clock instead of wall-clock. */
interface PendingDismiss {
  readonly dueAt: number
  readonly fire: () => void
}

/**
 * The virtual clock backing the banner auto-dismiss. `schedule` mirrors the
 * `scheduleDismiss` prop contract (callback + ms → cancel); `advance` fires
 * every callback whose deadline has passed. No wall-clock is ever consulted, so
 * a TTL assertion takes ≈0 real time (D-P2 / R-P2).
 */
export interface VirtualClock {
  schedule(callback: () => void, ms: number): () => void
  advance(ms: number): void
}

export function createVirtualClock(): VirtualClock {
  let now = 0
  let pending: PendingDismiss[] = []
  return {
    schedule(callback, ms): () => void {
      const entry: PendingDismiss = { dueAt: now + ms, fire: callback }
      pending.push(entry)
      return () => {
        pending = pending.filter((p) => p !== entry)
      }
    },
    advance(ms): void {
      now += ms
      const due = pending.filter((p) => p.dueAt <= now)
      pending = pending.filter((p) => p.dueAt > now)
      for (const p of due) p.fire()
    },
  }
}

export interface HarnessApi {
  dispatch(intent: StepsViewIntent): void
  emitBanner(level: 'info' | 'error', text: string): void
}

export interface ModelHarnessProps {
  readonly base: StepsViewState
  readonly now: number
  readonly clock: VirtualClock
  readonly initialBanner?: Banner
  readonly onApi: (api: HarnessApi) => void
}

export function ModelHarness({
  base,
  now,
  clock,
  initialBanner,
  onApi,
}: ModelHarnessProps): ReactElement {
  const [view, setView] = useState<ViewMode>(LIVE_VIEW)
  const [banner, setBanner] = useState<Banner | undefined>(initialBanner)
  const [, setSeq] = useState(initialBanner?.seq ?? 0)

  const dispatch = useCallback((intent: StepsViewIntent): void => {
    if (intent.type === 'enter') {
      setView({ mode: 'replay', stepName: intent.stepName })
    } else if (intent.type === 'follow-live') {
      setView(LIVE_VIEW)
    } else if (intent.type === 'dismiss-banner') {
      setBanner(undefined)
    }
    // 'quit' has no projection effect in the model substrate.
  }, [])

  const emitBanner = useCallback((level: 'info' | 'error', text: string): void => {
    setSeq((prev) => {
      const next = prev + 1
      setBanner({ kind: level, text, seq: next })
      return next
    })
  }, [])

  // Stable reference (the StepsView auto-dismiss effect lists it in its deps; an
  // inline closure would re-arm the timer every render).
  const scheduleDismiss = useCallback(
    (cb: () => void, ms: number): (() => void) => clock.schedule(cb, ms),
    [clock],
  )

  useEffect(() => {
    onApi({ dispatch, emitBanner })
  }, [onApi, dispatch, emitBanner])

  // The state the real component renders: synthetic base + live `view` + banner.
  const state = { ...base, view, ...(banner !== undefined ? { banner } : {}) } as StepsViewState
  return createElement(StepsView, {
    state,
    onIntent: dispatch,
    now: () => now,
    scheduleDismiss,
  })
}
