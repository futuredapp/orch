/**
 * `interactive-core.ts` — the channel/engine/lifecycle primitives shared by the
 * two interactive entries:
 *
 *   - `interactive-entry.ts` — the raw line-printer (deterministic; the default
 *     used by the test harness and the non-TTY integration test).
 *   - `ink-entry.tsx`        — the Ink list+input TUI (human/dev driving).
 *
 * Both read the SAME two input channels (manual keystrokes + the NDJSON control
 * file) routed through ONE engine, and both honour the SAME durable on-disk
 * contracts (`.ready` marker, per-command `.ack`, the render log). Only the
 * presentation (raw stdout vs. Ink) and the manual-input source (raw stdin vs.
 * an Ink `<TextInput>`) differ — so everything that is NOT presentation lives
 * here and is injected with an `OutputSink`.
 *
 * No import-time side effects (CLAUDE.md rule 8): every function is pure or
 * captures its inputs at call time. In particular the self-reap parent pid is
 * resolved by an explicit `resolveOrchParentPid()` call, never at module load.
 */

import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import {
  type ControlPaths,
  ORCH_PARENT_PID_ENV,
  ORCH_RUN_STATE_DIR_ENV,
  ORCH_STEP_KEY_ENV,
  resolveControlPaths,
} from './addressing.ts'
import {
  controlToEngineOp,
  type EngineResult,
  type OutputSink,
  parseControlLine,
  runEngineOp,
} from './command-engine.ts'
import { writeAck } from './puppet-io.ts'

export const POLL_INTERVAL_MS = 30

export function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms))
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Self-reap (U6). ORCH_PARENT_PID is orch's own pid; a tmux-spawned child's
// `process.ppid` is the pane, which outlives orch — so it is the wrong probe.
// Fall back to `process.ppid` only when the env var is absent (e.g. a unit test
// spawning the entry directly, where `process.ppid` IS the real parent).
// ---------------------------------------------------------------------------
export function resolveOrchParentPid(): number {
  const raw = process.env[ORCH_PARENT_PID_ENV]
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : process.ppid
}

/** A liveness probe for the given orch pid: true once that process has exited. */
export function makeParentExited(orchPid: number): () => boolean {
  return () => {
    try {
      process.kill(orchPid, 0)
      return false
    } catch {
      return true
    }
  }
}

// Number of attempts to write the `.ready` marker — the only signal a driver's
// `waitForReady` polls, so a transient write failure must not leave it hanging.
const READY_WRITE_ATTEMPTS = 3

/**
 * Write the readiness marker (R13), carrying our pid as the attempt token.
 * Bounded retries on a transient failure; logs to stderr if every attempt
 * fails. Never throws — a marker hiccup must not crash the entry.
 */
export async function writeReadyMarker(readyPath: string): Promise<void> {
  for (let attempt = 1; attempt <= READY_WRITE_ATTEMPTS; attempt += 1) {
    try {
      await writeFile(readyPath, String(process.pid), 'utf-8')
      return
    } catch (err) {
      if (attempt === READY_WRITE_ATTEMPTS) {
        process.stderr.write(
          `interactive fake: failed to write .ready marker after ${READY_WRITE_ATTEMPTS} attempts: ${err instanceof Error ? err.message : String(err)}\n`,
        )
        return
      }
      await sleep(POLL_INTERVAL_MS)
    }
  }
}

export interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
}

export function createDeferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/** Resolve the control transport from the threaded env (U1/U3). */
export function resolveControlFromEnv(): ControlPaths {
  const key = process.env[ORCH_STEP_KEY_ENV]
  const runStateDir = process.env[ORCH_RUN_STATE_DIR_ENV]
  if (
    key === undefined ||
    key.length === 0 ||
    runStateDir === undefined ||
    runStateDir.length === 0
  ) {
    throw new Error(`interactive fake: ${ORCH_STEP_KEY_ENV}/${ORCH_RUN_STATE_DIR_ENV} must be set`)
  }
  return resolveControlPaths({ runStateDir, key })
}

// ---------------------------------------------------------------------------
// The single engine queue. Both channels enqueue ops here so they run in
// arrival order on one chain — a control command already accepted runs and its
// `.ack` is written BEFORE a concurrently-arriving stdin `finish` terminates
// the process (the cross-channel contract that avoids a silent `waitForAck`
// hang).
// ---------------------------------------------------------------------------
export interface Engine {
  enqueue(task: () => Promise<void> | void): void
  readonly drained: () => Promise<void>
  readonly stopped: () => boolean
  stop(): void
}

export function createEngine(): Engine {
  let chain: Promise<void> = Promise.resolve()
  let stopped = false
  return {
    enqueue(task) {
      // Keep the chain resilient — one failed task must not wedge the queue —
      // but make the failure observable rather than silently discarded.
      chain = chain.then(task).catch((err) => {
        process.stderr.write(
          `interactive fake: engine task failed: ${err instanceof Error ? err.message : String(err)}\n`,
        )
      })
    },
    drained: () => chain,
    stopped: () => stopped,
    stop() {
      stopped = true
    },
  }
}

// Run one parsed control command: render/finish via the engine, write its ack,
// and resolve `finished` on terminate.
async function runControlCommand(
  parsed: ReturnType<typeof parseControlLine>,
  localSeq: number,
  paths: ControlPaths,
  sink: OutputSink,
  finished: Deferred<number>,
): Promise<void> {
  if (parsed.kind === 'error') {
    process.stderr.write(
      `interactive fake: bad control command on line ${localSeq}: ${parsed.message}\n`,
    )
  }
  const op = parsed.kind === 'ok' ? controlToEngineOp(parsed.value) : null
  const outcome: EngineResult = op !== null ? runEngineOp(op, sink) : { kind: 'continue' }
  await writeAck(paths.ackDir, localSeq, outcome)
  if (outcome.kind === 'terminate') finished.resolve(outcome.exitCode ?? 0)
}

/**
 * The control-file reader. `drainOnce` reads any bytes appended since the last
 * call and enqueues one task per new command. Stateful (cursor + seq) so the
 * poll loop AND a coordinator's post-`finish` final drain share one cursor.
 */
export interface ControlReader {
  drainOnce(): Promise<void>
}

export function createControlReader(
  paths: ControlPaths,
  sink: OutputSink,
  engine: Engine,
  finished: Deferred<number>,
): ControlReader {
  let cursor = 0
  let buffer = ''
  let seq = 0
  return {
    async drainOnce(): Promise<void> {
      let raw = ''
      try {
        raw = await readFile(paths.controlPath, 'utf-8')
      } catch {
        raw = ''
      }
      if (raw.length <= cursor) return
      buffer += raw.slice(cursor)
      cursor = raw.length
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim().length === 0) continue
        seq += 1
        const localSeq = seq
        const parsed = parseControlLine(line)
        engine.enqueue(() => runControlCommand(parsed, localSeq, paths, sink, finished))
      }
    },
  }
}

export async function controlPollLoop(
  reader: ControlReader,
  engine: Engine,
  finished: Deferred<number>,
  parentExited: () => boolean,
): Promise<void> {
  while (!engine.stopped()) {
    if (parentExited()) {
      finished.resolve(0)
      return
    }
    await reader.drainOnce()
    await sleep(POLL_INTERVAL_MS)
  }
}

export async function reapLoop(
  engine: Engine,
  finished: Deferred<number>,
  parentExited: () => boolean,
): Promise<void> {
  while (!engine.stopped()) {
    if (parentExited()) {
      finished.resolve(0)
      return
    }
    await sleep(POLL_INTERVAL_MS)
  }
}

/**
 * Prepare the control transport on disk: create the dirs, ensure the control
 * file exists, and delete any stale `.ready` / render log from a prior attempt
 * in the same runId dir (so a driver's `waitForReady` cannot resolve against a
 * marker this process did not write).
 */
export async function prepareControlDir(paths: ControlPaths): Promise<void> {
  await mkdir(paths.controlDir, { recursive: true })
  await mkdir(paths.ackDir, { recursive: true })
  if (!(await fileExists(paths.controlPath))) {
    await writeFile(paths.controlPath, '', 'utf-8')
  }
  await rm(paths.readyPath, { force: true }).catch(() => {})
  await rm(paths.renderLogPath, { force: true }).catch(() => {})
}
