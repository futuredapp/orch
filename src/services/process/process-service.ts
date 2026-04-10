import type { Path } from '../types.ts'

export interface SpawnOptions {
  readonly argv: readonly string[]
  readonly cwd: Path
  /** Full replacement. No automatic merge with process.env. */
  readonly env: Readonly<Record<string, string>>
}

export interface SpawnHandle {
  /** Line-framed stdout. One yield per logical line. */
  readonly stdout: AsyncIterable<string>
  /** Line-framed stderr. Drained concurrently from spawn time (see Watch-outs S1). */
  readonly stderr: AsyncIterable<string>
  wait(): Promise<{ readonly exitCode: number }>
  /** Defaults to 'SIGTERM'. */
  kill(signal?: NodeJS.Signals): void
}

export interface ProcessService {
  spawn(opts: SpawnOptions): SpawnHandle
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
