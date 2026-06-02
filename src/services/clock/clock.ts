export interface Clock {
  /** Returns epoch milliseconds. */
  now(): number
  /**
   * Resolve after `ms` milliseconds. `BunClock` backs this with `setTimeout`;
   * `FakeClock` queues sleepers and resolves them on `advance()` so polling
   * loops can run deterministically under unit tests.
   *
   * Pass `signal` to make the sleep cancellable: on abort it resolves early and
   * clears the underlying timer. The recovery loop's stall watchdog relies on
   * this so a fast-completing attempt does not leave a long timer pending and
   * hold the process alive (U7).
   */
  sleep(ms: number, signal?: AbortSignal): Promise<void>
}
