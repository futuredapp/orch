#!/usr/bin/env bun
/**
 * `interactive-entry.ts` — the RAW interactive entry (U4): a deterministic
 * line-printer. The default interactive UI, used by the test harness and the
 * non-TTY integration test (which pipes stdin, so it cannot use Ink's raw-mode
 * `useInput`). The Ink list+input sibling is `ink-entry.tsx`.
 *
 * Spawned by the two-pane / plain host as a real PTY. It reads two input
 * channels — manual stdin keystrokes and the NDJSON control file — both routed
 * through the SAME shared engine (`command-engine.ts` via `interactive-core.ts`)
 * as the headless path, so `type_and_send` / `finish` behave identically across
 * modes and channels (R1, R3, R4, R5). The lifecycle (engine queue, control
 * reader, poll/reap loops, `.ready` marker, self-reap) lives in
 * `interactive-core.ts`; this file supplies only the raw presentation (stdout
 * line writes) and the raw-stdin input source.
 *
 * Inputs (env, threaded by the executor at spawn — U1): `ORCH_STEP_KEY`,
 * `ORCH_RUN_STATE_DIR`, `ORCH_PARENT_PID`.
 *
 * `finish` is clean-exit only (plan §Key Technical Decisions): `pane-died`
 * carries no exit code, so a non-zero `finish(code)` is not propagated here.
 */

import { appendFileSync } from 'node:fs'
import type { OutputSink } from './command-engine.ts'
import { parseManualLine, runEngineOp } from './command-engine.ts'
import {
  controlPollLoop,
  createControlReader,
  createDeferred,
  createEngine,
  type Deferred,
  type Engine,
  makeParentExited,
  prepareControlDir,
  reapLoop,
  resolveControlFromEnv,
  resolveOrchParentPid,
  writeReadyMarker,
} from './interactive-core.ts'

// Interactive output sink: render a line into the live PTY pane AND append it to
// the durable render log (the interactive analog of the headless tee — a
// race-free on-disk oracle a driver polls instead of scraping the pane). `\r\n`
// on stdout renders cleanly regardless of the pty's OPOST/ONLCR state; the log
// keeps plain `\n`. The append is synchronous so the line is durable even if
// `finish` exits on the next tick. `finish` is a no-op — the coordinator drives
// the clean exit after the engine queue drains.
function interactiveSink(renderLogPath: string): OutputSink {
  return {
    typeLine(text: string): void {
      process.stdout.write(`${text}\r\n`)
      appendFileSync(renderLogPath, `${text}\n`)
    },
    finish(_code: number): void {
      // Interactive finish is clean-exit-only: the host's `pane-died` carries no
      // exit code, so `_code` is intentionally dropped. The clean exit itself is
      // driven by the coordinator (see main) once the engine queue drains.
    },
  }
}

function startStdinReader(sink: OutputSink, engine: Engine, finished: Deferred<number>): void {
  const stdin = process.stdin
  if (stdin.isTTY) {
    try {
      stdin.setRawMode(true)
    } catch {
      /* not all PTYs accept raw mode; fall back to cooked line reads */
    }
  }
  stdin.resume()
  stdin.setEncoding('utf-8')
  let buf = ''
  stdin.on('data', (chunk: string) => {
    buf += chunk
    for (;;) {
      const idx = buf.search(/[\r\n]/)
      if (idx < 0) break
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      const op = parseManualLine(line)
      if (op === null) continue
      engine.enqueue(() => {
        const outcome = runEngineOp(op, sink)
        if (outcome.kind === 'terminate') finished.resolve(outcome.exitCode ?? 0)
      })
    }
  })
}

function restoreTerminal(): void {
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(false)
    } catch {
      /* best-effort */
    }
  }
}

async function main(): Promise<number> {
  const paths = resolveControlFromEnv()
  await prepareControlDir(paths)

  const sink = interactiveSink(paths.renderLogPath)
  const engine = createEngine()
  const finished = createDeferred<number>()
  const reader = createControlReader(paths, sink, engine, finished)
  const parentExited = makeParentExited(resolveOrchParentPid())

  startStdinReader(sink, engine, finished)
  void controlPollLoop(reader, engine, finished, parentExited)
  void reapLoop(engine, finished, parentExited)

  // Idle-waiting (R13): nothing to render yet, so we are idle the moment the
  // channels are wired. Write the marker (bounded-retry, logs on failure).
  await writeReadyMarker(paths.readyPath)

  await finished.promise
  // Final control drain BEFORE stopping: a control command appended just before
  // a concurrent stdin `finish` may not have been polled yet. Read + enqueue its
  // ack now so a driver awaiting that ack never hangs (cross-channel contract).
  await reader.drainOnce()
  engine.stop()
  // Drain any ack/render work enqueued before `finish` (and by the final drain)
  // so every accepted command's ack is flushed before we exit.
  await engine.drained()
  restoreTerminal()
  // Interactive `finish` is clean-exit only: tmux's `pane-died` carries no exit
  // code, so the host returns 0 regardless. We exit 0 even for `finish(2)`.
  return 0
}

// SIGHUP/SIGTERM (U6): handle them so the primary reap path (tmux pane kill on
// teardown) reliably terminates us with the terminal restored.
for (const sig of ['SIGHUP', 'SIGTERM'] as const) {
  process.on(sig, () => {
    restoreTerminal()
    process.exit(0)
  })
}

try {
  const code = await main()
  restoreTerminal()
  process.exit(code)
} catch (err) {
  restoreTerminal()
  process.stderr.write(`interactive fake: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
}
