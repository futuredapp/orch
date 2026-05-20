import type { Path } from '../types.ts'

export interface SpawnOptions {
  readonly argv: readonly string[]
  readonly cwd: Path
  /** Full replacement. No automatic merge with process.env. */
  readonly env: Readonly<Record<string, string>>
  /**
   * Observational marker consumed by wrappers that log subprocess activity
   * (see `instrumentProcessService`). Runners set `tag: 'agent'` so the
   * subprocess logger skips them — agent spawns already land in
   * `spawns.ndjson`. Ignored by the real process service.
   */
  readonly tag?: string
  /**
   * Opt-in raw-stream mode for the Tier 5 behavioral harness. When `true`:
   *
   *  - `stdin` is piped (writable). The returned `SpawnHandle` exposes
   *    `writeStdin(data)` for fire-and-forget bytes.
   *  - `stdout` is tee'd into two consumers: the existing line-framed
   *    iterable (`stdout: AsyncIterable<string>`) AND a cumulative raw-byte
   *    accumulator (`stdoutBytes(): Buffer`). The two views are independent —
   *    consuming one does not drain the other.
   *
   * Ignored by callers that don't care. Runners and command/commit steps MUST
   * leave this unset — they only need the line-framed view, and adding the
   * raw consumer has a per-spawn cost (a `tee()` plus background buffering).
   *
   * See `tests/helpers/behavioral-dsl/` and `docs/plans/2026-05-20-001-…-plan.md`
   * (U2) for the consumer.
   */
  readonly rawStreams?: boolean
}

// ---------------------------------------------------------------------------
// ProcessHandle — shared base for spawn() and spawnForeground()
// ---------------------------------------------------------------------------

export interface ProcessHandle {
  wait(): Promise<{ readonly exitCode: number }>
  /** Defaults to 'SIGTERM'. */
  kill(signal?: NodeJS.Signals): void
}

export interface SpawnHandle extends ProcessHandle {
  /** Line-framed stdout. One yield per logical line. */
  readonly stdout: AsyncIterable<string>
  /** Line-framed stderr. Drained concurrently from spawn time (see Watch-outs S1). */
  readonly stderr: AsyncIterable<string>
  /**
   * Present iff the spawn used `rawStreams: true`. Fire-and-forget write to
   * the child's stdin. Errors after write surface via the next `wait()`
   * resolution.
   */
  readonly writeStdin?: (data: string | Uint8Array) => void
  /**
   * Present iff the spawn used `rawStreams: true`. Returns a cumulative
   * `Buffer` of every byte received on stdout since spawn — monotonically
   * growing, never reset. Independent of the line-framed `stdout` iterable
   * (consuming one does not affect the other).
   */
  readonly stdoutBytes?: () => Buffer
  /**
   * Present iff the spawn used `rawStreams: true`. Closes the child's stdin
   * (delivers stdin-EOF). Distinct from a controlling-TTY hangup — a
   * piped-stdin child receives EOF on the read side, not SIGHUP. Idempotent.
   * Consumed by `tests/helpers/behavioral-dsl/user-actions.ts`'s
   * `closeStdin()` action (plan U10).
   */
  readonly closeStdin?: () => void
}

/** Foreground processes inherit stdio — no stream access. */
export type ForegroundHandle = ProcessHandle

export interface ProcessService {
  spawn(opts: SpawnOptions): SpawnHandle
  /** Spawn a foreground process that inherits stdin/stdout/stderr. */
  spawnForeground(opts: SpawnOptions): ForegroundHandle
}

/** Thrown synchronously when the binary is missing or cwd does not exist. */
export class ProcessSpawnError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'ProcessSpawnError'
  }
}
