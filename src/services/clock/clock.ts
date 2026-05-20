export interface Clock {
  /** Returns epoch milliseconds. */
  now(): number
  /**
   * Resolve after `ms` milliseconds. `BunClock` backs this with `setTimeout`;
   * `FakeClock` queues sleepers and resolves them on `advance()` so polling
   * loops can run deterministically under unit tests.
   */
  sleep(ms: number): Promise<void>
}
