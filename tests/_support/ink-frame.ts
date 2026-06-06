// Deterministic waits for ink-testing-library frames and intent callbacks.
//
// `ink-testing-library` processes `stdin.write(...)` and re-renders
// asynchronously, so reading `lastFrame()` after a fixed `setTimeout` is a
// race: under load the keypress may not have re-rendered yet, and the
// assertion sees a stale frame (the steps-view preview-cursor flake,
// 2026-05-26). These helpers poll until the expected state is observed (or a
// budget expires with a useful diagnostic), instead of guessing a sleep.

const DEFAULT_TIMEOUT_MS = 1_000
const DEFAULT_INTERVAL_MS = 10

interface InkRenderResult {
  lastFrame(): string | undefined
}

interface InkRenderResultWithStdin extends InkRenderResult {
  readonly stdin: { write(data: string): void }
}

export interface WaitForFrameOptions {
  /** Give up after this many ms. Default 1000. */
  readonly timeoutMs?: number
  /** Poll cadence. Default 10ms. */
  readonly intervalMs?: number
  /** Applied to each frame before the predicate runs and before returning (e.g. `stripAnsi`). */
  readonly transform?: (frame: string) => string
}

/**
 * Poll `ui.lastFrame()` until `predicate` accepts it, then return the
 * (transformed) frame. Throws with the last frame attached if the budget
 * expires — turning a render race into a deterministic pass or a legible fail.
 */
export async function waitForFrame(
  ui: InkRenderResult,
  predicate: (frame: string) => boolean,
  opts: WaitForFrameOptions = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS
  const transform = opts.transform ?? ((frame: string): string => frame)
  const deadline = Date.now() + timeoutMs

  for (;;) {
    const frame = transform(ui.lastFrame() ?? '')
    if (predicate(frame)) return frame
    if (Date.now() >= deadline) {
      throw new Error(
        `waitForFrame: predicate not satisfied within ${timeoutMs}ms. Last frame:\n${frame}`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/**
 * Send `key` repeatedly until `predicate` accepts the resulting frame, then
 * return it. This defeats two races at once: Ink's `useInput` subscribes on a
 * mount effect (a write before that is silently dropped, and there is no
 * frame-observable signal for the subscription), and a single post-subscribe
 * write can land between renders. Resending until the state appears removes
 * both.
 *
 * SAFE ONLY for keys that are idempotent with respect to the asserted state —
 * e.g. boundary navigation (`↑` at the top row, `↓` at the bottom) or a
 * snap-to-live `f`. Do NOT use it for a key whose Nth press differs from its
 * first (it may be delivered more than once).
 */
export async function pressUntilFrame(
  ui: InkRenderResultWithStdin,
  key: string,
  predicate: (frame: string) => boolean,
  opts: WaitForFrameOptions = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS
  const transform = opts.transform ?? ((frame: string): string => frame)
  const deadline = Date.now() + timeoutMs

  for (;;) {
    ui.stdin.write(key)
    const frame = transform(ui.lastFrame() ?? '')
    if (predicate(frame)) return frame
    if (Date.now() >= deadline) {
      throw new Error(
        `pressUntilFrame: predicate not satisfied within ${timeoutMs}ms. Last frame:\n${frame}`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/**
 * Poll a growing intent log until `predicate` accepts it. Use after a keypress
 * that should (or should not, with a settle delay) fire an intent — the
 * keypress handler runs asynchronously, so reading the log after a fixed sleep
 * is the same race as `waitForFrame`.
 */
export async function waitForIntents<T>(
  read: () => readonly T[],
  predicate: (intents: readonly T[]) => boolean,
  opts: { readonly timeoutMs?: number; readonly intervalMs?: number } = {},
): Promise<readonly T[]> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS
  const deadline = Date.now() + timeoutMs

  for (;;) {
    const intents = read()
    if (predicate(intents)) return intents
    if (Date.now() >= deadline) {
      throw new Error(
        `waitForIntents: predicate not satisfied within ${timeoutMs}ms. Saw: ${JSON.stringify(intents)}`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}
