// A controllable timer for deterministic component tests.
//
// `<StepsView>` schedules its info-banner auto-dismiss through an injectable
// `scheduleDismiss(callback, ms)` prop (default `setTimeout`). Driving that with
// real wall-clock makes tests race the React scheduler — they assert "no
// dismiss before Nms / dismiss after" against true elapsed time, which is the
// banner auto-dismiss flake (2026-05-26). A ManualTimer replaces wall-clock
// with an internal clock the test advances explicitly: callbacks fire only on
// `advance(...)`, never on their own.
//
// `schedule` is a stable bound method, so it is safe as a `useEffect`
// dependency (it will not re-arm the effect every render).

interface ScheduledCallback {
  readonly id: number
  readonly dueAt: number
  readonly callback: () => void
}

export interface ManualTimer {
  /** Drop-in for `scheduleDismiss`: registers `callback` to fire `ms` of
   *  ADVANCED time from now. Returns a cancel fn that unregisters it. */
  readonly schedule: (callback: () => void, ms: number) => () => void
  /** Advance the internal clock by `ms`, firing every callback now due (in
   *  dueAt order). Callbacks scheduled during a fire stay queued for the next
   *  advance, matching real timer semantics. */
  advance(ms: number): void
}

export function createManualTimer(): ManualTimer {
  let now = 0
  let nextId = 0
  let pending: ScheduledCallback[] = []

  const schedule = (callback: () => void, ms: number): (() => void) => {
    const id = nextId++
    pending.push({ id, dueAt: now + ms, callback })
    return () => {
      pending = pending.filter((entry) => entry.id !== id)
    }
  }

  const advance = (ms: number): void => {
    if (ms < 0) throw new Error('ManualTimer.advance: ms must be >= 0')
    now += ms
    const due = pending.filter((entry) => entry.dueAt <= now).sort((a, b) => a.dueAt - b.dueAt)
    pending = pending.filter((entry) => entry.dueAt > now)
    for (const entry of due) entry.callback()
  }

  return { schedule, advance }
}
