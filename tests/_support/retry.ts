export interface RetryUntilOptions {
  readonly maxAttempts: number
  readonly perAttemptMs: number
  readonly waitAfterAttempt?: (timeoutMs: number) => Promise<void>
}

export async function retryUntil(
  send: () => Promise<void> | void,
  check: () => Promise<boolean> | boolean,
  opts: RetryUntilOptions,
): Promise<boolean> {
  for (let i = 0; i < opts.maxAttempts; i++) {
    if (await check()) return true
    await send()
    await waitAfterAttempt(opts)
  }
  return check()
}

async function waitAfterAttempt(opts: RetryUntilOptions): Promise<void> {
  if (opts.waitAfterAttempt !== undefined) {
    await opts.waitAfterAttempt(opts.perAttemptMs).catch(() => {})
    return
  }
  await new Promise((resolve) => setTimeout(resolve, opts.perAttemptMs))
}
