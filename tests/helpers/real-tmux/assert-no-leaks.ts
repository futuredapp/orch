// Leaked-process guard for the predictable fake (U6 — R14).
//
// The scar this guards against: a blocking scripted-fake entry whose parent
// (orch / the test) died without reaping it reparents to init and polls
// forever, piling up across runs until the CPU starves and the whole suite
// flakes (~8× slowdown — docs/solutions/real-tmux-suite-flakiness-leaked-
// puppets.md). The actual PREVENTION is the entry's parent-liveness self-reap
// (`__entry.ts` / `interactive-entry.ts`) plus tmux killing the pane on
// teardown. This helper is a post-hoc SENTINEL: it converts a silent leak into
// a loud test failure, it does not prevent one.
//
// We match the entry scripts by their on-disk path segment `scripted-fake/`
// (with a slash). That matches the spawned `bun .../scripted-fake/__entry.ts`
// and `.../scripted-fake/interactive-entry.ts` children, but NOT the hyphenated
// test-file path (`scripted-fake-interactive.test.ts`) carried in the test
// runner's own argv — so the runner never inflates the count.
//
// Usage is baseline-relative: snapshot the count before a run, assert it
// returns to that baseline after teardown. Baseline-relative (not absolute
// zero) so a parent suite that legitimately has fakes mid-flight in another
// test cannot make this one spuriously fail.

const ENTRY_PATTERN = 'scripted-fake/'
const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_POLL_MS = 50

export interface LeakedEntry {
  readonly pid: number
  /** The `pgrep -fl` line (pid + command), for a useful failure message. */
  readonly line: string
}

/**
 * Every live scripted-fake entry process (`__entry.ts` + `interactive-entry.ts`).
 * `pgrep` exits 1 when there are no matches — that is success here, not an error.
 */
export async function listScriptedFakeEntries(): Promise<readonly LeakedEntry[]> {
  const proc = Bun.spawn(['pgrep', '-fl', ENTRY_PATTERN], { stdout: 'pipe', stderr: 'ignore' })
  const out = await new Response(proc.stdout as ReadableStream<Uint8Array>).text()
  await proc.exited
  const self = process.pid
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((line) => {
      const space = line.indexOf(' ')
      const pid = Number(space === -1 ? line : line.slice(0, space))
      return { pid, line }
    })
    .filter((e) => Number.isInteger(e.pid) && e.pid !== self)
}

/** Current count of live scripted-fake entry processes. */
export async function scriptedFakeEntryCount(): Promise<number> {
  return (await listScriptedFakeEntries()).length
}

export interface AssertNoLeaksOptions {
  readonly timeoutMs?: number
  readonly pollMs?: number
}

/**
 * Assert the live scripted-fake entry count returns to `baseline` after a run's
 * teardown. Polls (teardown's tmux-server kill → child SIGHUP → exit is not
 * instantaneous) and returns on the first reading at-or-below baseline; throws
 * with the offending command lines if it never settles within the budget.
 */
export async function assertNoLeakedEntries(
  baseline: number,
  opts: AssertNoLeaksOptions = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS
  const deadline = Date.now() + timeoutMs

  let entries = await listScriptedFakeEntries()
  while (entries.length > baseline) {
    if (Date.now() >= deadline) {
      const lines = entries.map((e) => `  ${e.line}`).join('\n')
      throw new Error(
        `leaked ${entries.length - baseline} scripted-fake entry process(es) above baseline ${baseline} after teardown:\n${lines}`,
      )
    }
    await new Promise((r) => setTimeout(r, pollMs))
    entries = await listScriptedFakeEntries()
  }
}
