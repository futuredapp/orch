import type { Path } from '../types.ts'

export interface SpawnOptions {
  readonly argv: readonly string[]
  readonly cwd: Path
  /** Full replacement. No automatic merge with process.env. */
  readonly env: Readonly<Record<string, string>>
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
