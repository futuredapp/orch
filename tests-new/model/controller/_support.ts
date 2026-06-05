// Shared fixtures for the `model/controller` category — the right-pane-controller
// decision tests. These are plain `bun:test` class tests against the
// `FakeTmuxService` seam (no tmux, no rendering); see ./README.md for why this
// is a non-`scenario()` category. The helpers below are the boilerplate the old
// `tests/unit/hosts/two-pane/pane-map/*` files each carried inline; co-locating
// them here keeps each relocated test reading as Arrange-Act-Assert sentences.

import { Writable } from 'node:stream'
import { readFile } from 'node:fs/promises'
import type { SessionLogger } from '../../../src/observability/index.ts'
import { createNullSessionLogger } from '../../../src/observability/index.ts'
import type { FakeTmuxService, SocketName } from '../../../src/services/tmux/index.ts'
import { path as toPath } from '../../../src/services/types.ts'
import type {
  RunId,
  RunState,
  StateStore,
  StepEntry,
} from '../../../src/state/index.ts'

/** A black-hole stderr — the controller must never bleed to fd-2 (Bug B). */
export function bufferStream(): NodeJS.WritableStream {
  return new Writable({
    write(_c, _e, cb) {
      cb()
    },
  }) as unknown as NodeJS.WritableStream
}

export interface CapturingStderr {
  readonly stream: NodeJS.WritableStream
  readonly chunks: string[]
}

/** A stderr that records what was written, for the "no stderr bleed" assertions. */
export function capturingStderr(): CapturingStderr {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString())
      cb()
    },
  }) as unknown as NodeJS.WritableStream
  return { stream, chunks }
}

export interface CapturedLog {
  readonly logger: SessionLogger
  readonly entries: Array<{ readonly category: string; readonly record: unknown }>
}

/** A SessionLogger that captures appended lifecycle records for inspection. */
export function capturingLogger(runId: RunId): CapturedLog {
  const base = createNullSessionLogger({ runId })
  const entries: CapturedLog['entries'] = []
  const logger: SessionLogger = {
    ...base,
    append: async (category, record): Promise<void> => {
      entries.push({ category, record })
    },
  }
  return { logger, entries }
}

/** Build a single persisted step entry with sensible defaults. */
export function makeStep(
  overrides: Partial<StepEntry> & Pick<StepEntry, 'name'>,
): StepEntry {
  return {
    name: overrides.name,
    value: overrides.value ?? null,
    startedAt: 1000,
    endedAt: 2000,
    artifacts: [],
    validations: [],
    transcriptEventCount: 0,
    transcriptTruncated: false,
    ...(overrides.mode !== undefined ? { mode: overrides.mode } : {}),
    ...(overrides.transcriptPath !== undefined ? { transcriptPath: overrides.transcriptPath } : {}),
    ...(overrides.sessionId !== undefined ? { sessionId: overrides.sessionId } : {}),
    ...(overrides.runnerName !== undefined ? { runnerName: overrides.runnerName } : {}),
    ...(overrides.sessionIdCaptureError !== undefined
      ? { sessionIdCaptureError: overrides.sessionIdCaptureError }
      : {}),
  }
}

/** A read-only StateStore over a fixed set of steps for the given run. */
export function makeStore(
  runId: RunId,
  steps: Record<string, StepEntry>,
  status: RunState['status'] = 'running',
): StateStore {
  const state: RunState = {
    schemaVersion: 5,
    id: runId,
    status,
    workflowName: 'demo',
    startedAt: 0,
    steps,
  }
  return {
    loadRun: async (rid) => (rid === runId ? state : undefined),
    saveStep: async () => {
      throw new Error('not implemented')
    },
    initRun: async () => {
      throw new Error('not implemented')
    },
    setStatus: async () => {
      throw new Error('not implemented')
    },
    setArgs: async () => {
      throw new Error('not implemented')
    },
    runDir: (rid) => toPath(`/runs/${rid}`),
  }
}

/** Drain the controller's fire-and-forget microtask/macrotask work. */
export async function flush(iterations = 8): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    await new Promise((r) => setTimeout(r, 0))
  }
}

/** Read non-empty lines from a TUI-overlay ndjson file, tolerating absence. */
export async function readOverlayLines(path: string): Promise<readonly string[]> {
  try {
    const text = await readFile(path, 'utf8')
    return text.split('\n').filter((l) => l.length > 0)
  } catch {
    return []
  }
}

/**
 * Pane ids the fake still reports as owned by a live session on `socket`. A swap
 * whose `src`/`dst` is not in this set targets a torn-down pane — exactly the
 * "can't find pane" condition real tmux raises. The fake models per-session pane
 * ownership and clears it on `killSession`, so this is load-bearing with no fake
 * modification.
 */
export function liveOwnedPanes(
  tmux: FakeTmuxService,
  socket: SocketName,
  sessions: readonly string[],
): Set<string> {
  const owned = new Set<string>()
  for (const session of sessions) {
    for (const pane of tmux.paneIdsForSession(socket, session)) {
      owned.add(String(pane))
    }
  }
  return owned
}
