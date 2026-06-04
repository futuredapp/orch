#!/usr/bin/env bun
/**
 * `__entry.ts` — the per-step subprocess driven by `ScriptedFakeRunner`.
 *
 * Spawned by `runRunner(...)` against the argv the runner's `buildCommand`
 * returned. Reads its inputs from `process.env`:
 *
 *   ORCH_LIFECYCLE_SCRIPT       — absolute path to the script JSON file
 *   ORCH_LIFECYCLE_STEP_NAME    — the step name this invocation belongs to
 *
 * Dispatches on `StepScript.kind` and writes the appropriate
 * `RunnerEvent`s (NDJSON) to stdout, then exits with the script-dictated
 * code. `emit-then-hang` keeps the process alive until killed.
 *
 * Crash semantics: any thrown error becomes a `terminal/error` line on
 * stdout followed by `process.exit(1)` so the parent always sees a
 * terminal event (matches the executor's invariant in
 * `src/runners/execute.ts`).
 *
 * NOTE on size: this file runs over the 300-line soft limit (CLAUDE.md rule
 * #5). The headless puppet lifecycle — control-path resolution, the legacy
 * command dispatch (`emit`/`write-file`/`run-shell`/`complete`/`fail`/`wait`),
 * the `.ready`/`.ack` machinery, and the `parentExited()` self-reap — is one
 * tightly-coupled process concern; splitting it would scatter a single process
 * lifecycle across files for no clarity gain (mirrors `interactive-entry.ts`).
 */

import { rm, writeFile as writeFileNode } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { BunFsService } from '../../services/fs/index.ts'
import type { RunnerEvent, TerminalEvent } from '../types.ts'
import {
  type ControlPaths,
  controlPathsForControlFile,
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
import { loadScriptedFakeScript, resolveStepScript, ScriptLoadError } from './script-loader.ts'
import type {
  EmitThenHangScript,
  InstantFailScript,
  InstantOkScript,
  PuppetCommand,
  PuppetScript,
  StepScript,
  WaitForFileScript,
} from './types.ts'

const DEFAULT_GATE_POLL_INTERVAL_MS = 50

const ORCH_LIFECYCLE_STEP_NAME_ENV = 'ORCH_LIFECYCLE_STEP_NAME'

// The orch parent that spawned us. The blocking scripts (`puppet`,
// `emit-then-hang`, `wait-for-file`) are designed to run until the parent
// kills them by signal. But the behavioral harness tears orch down with
// SIGKILL, which is uncatchable — orch dies without reaping its children, so
// a hanging __entry would reparent to init and poll forever. Left unchecked
// these orphans accumulate across runs and starve the CPU, which is what
// slows the suite ~8× and turns real-tmux timing budgets into flakes.
//
// We capture the spawn-time parent pid and probe its liveness, rather than
// reading `process.ppid` each tick: Bun caches `process.ppid` at startup, so
// it keeps reporting orch's pid even after we reparent to init. `kill(pid, 0)`
// sends no signal — it just succeeds if the pid exists and throws ESRCH once
// orch is gone. Reading process.ppid here is a pure read — no import-time side
// effect.
//
// Headless entries are spawned directly by orch via ProcessService (not tmux),
// so `process.ppid` IS orch and is the correct self-reap probe here — unlike
// the interactive entry, which is tmux-spawned and must read `ORCH_PARENT_PID`
// because its `process.ppid` is the pane, not orch.
const SPAWN_PARENT_PID = process.ppid

/** True once orch (our spawner) has exited, so a blocking script can self-reap. */
function parentExited(): boolean {
  try {
    process.kill(SPAWN_PARENT_PID, 0)
    return false
  } catch {
    // ESRCH — the original parent is gone. (EPERM cannot happen: orch is our
    // own child-of-the-same-user spawner.)
    return true
  }
}

function writeEvent(event: RunnerEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

async function runInstantOk(script: InstantOkScript): Promise<number> {
  for (const evt of script.events ?? []) writeEvent(evt)
  const terminal: TerminalEvent = {
    kind: 'terminal',
    type: 'turn-complete',
    ...(script.structuredOutput !== undefined ? { data: script.structuredOutput } : {}),
  }
  writeEvent(terminal)
  return 0
}

function runInstantFail(script: InstantFailScript): number {
  const terminal: TerminalEvent = {
    kind: 'terminal',
    type: 'error',
    message: script.message,
  }
  writeEvent(terminal)
  return script.exitCode ?? 1
}

async function runWaitForFile(script: WaitForFileScript): Promise<number> {
  const fs = new BunFsService()
  const interval = script.pollIntervalMs ?? DEFAULT_GATE_POLL_INTERVAL_MS
  const { path } = await import('../../services/types.ts')
  const gate = path(script.gatePath)

  while (true) {
    if (parentExited()) return 0
    if (await fs.exists(gate)) break
    await new Promise((res) => setTimeout(res, interval))
  }

  for (const evt of script.events ?? []) writeEvent(evt)
  writeEvent({ kind: 'terminal', type: 'turn-complete' })
  return 0
}

async function runEmitThenHang(script: EmitThenHangScript): Promise<number> {
  for (const evt of script.events) writeEvent(evt)
  // Block until the parent kills us (the script's contract is that orch
  // observes the hang) — but bail out if orch dies first so we never become a
  // forever-polling orphan. We do NOT emit a terminal event; the hang itself
  // is the observable.
  while (!parentExited()) {
    await new Promise((res) => setTimeout(res, DEFAULT_GATE_POLL_INTERVAL_MS))
  }
  return 0
}

const DEFAULT_PUPPET_POLL_INTERVAL_MS = 30

/**
 * Puppet driver. Tails an NDJSON command file written by the test harness
 * (`handle.agent(name).*`). Each line is parsed and dispatched. Terminates
 * on `complete` / `fail`; `wait` / `emit` / `write-file` / `run-shell` cycle
 * the loop. The control file is created lazily; if the directory does not
 * exist yet we create it so the test can write immediately on launch.
 */
interface PuppetReaderState {
  cursor: number
  lineCounter: number
  buffer: string
}

// `EngineResult` ({ kind: 'continue' | 'terminate'; exitCode? }) is the single
// loop-outcome shape shared by the engine, the per-command dispatch, and the
// per-batch reader — no parallel near-identical types, no re-wrapping.

/**
 * Headless output sink: `type_and_send` emits an `info` event the transcript
 * pipeline renders as an assistant line; `finish` writes the NDJSON terminal
 * event (turn-complete for 0, error otherwise) so the executor's
 * runner-exit → step:complete/step:failed path carries the code.
 */
function headlessSink(): OutputSink {
  return {
    typeLine(text: string): void {
      writeEvent({ kind: 'info', type: 'assistant', payload: { text } })
    },
    finish(code: number): void {
      if (code === 0) {
        writeEvent({ kind: 'terminal', type: 'turn-complete' })
      } else {
        writeEvent({ kind: 'terminal', type: 'error', message: `finished with code ${code}` })
      }
    },
  }
}

async function processPuppetBatch(
  raw: string,
  state: PuppetReaderState,
  ackDir: string,
  sink: OutputSink,
): Promise<EngineResult> {
  state.buffer += raw.slice(state.cursor)
  state.cursor = raw.length
  const lines = state.buffer.split('\n')
  state.buffer = lines.pop() ?? ''
  for (const line of lines) {
    if (line.trim().length === 0) continue
    const parsed = parseControlLine(line)
    if (parsed.kind === 'error') {
      writeEvent({
        kind: 'terminal',
        type: 'error',
        message: `puppet: bad command on line ${state.lineCounter}: ${parsed.message}`,
      })
      return { kind: 'terminate', exitCode: 1 }
    }
    state.lineCounter += 1
    const outcome = await dispatchPuppetCommand(parsed.value, sink)
    await writeAck(ackDir, state.lineCounter, outcome)
    if (outcome.kind === 'terminate') return { kind: 'terminate', exitCode: outcome.exitCode }
  }
  return { kind: 'continue' }
}

/**
 * Resolve the control transport (R7). The fallback discriminator is the
 * presence of a baked `script.controlPath` — it WINS (behavioral-dsl backward
 * compat). Otherwise derive the path from the run-time step key under the run
 * state dir, both threaded into the env by the executor (U1). Gating on the
 * key being absent would never fire — it is always threaded — so the baked
 * path is the discriminator.
 */
function resolvePuppetControl(script: PuppetScript): ControlPaths {
  const baked = script.controlPath
  if (baked !== undefined) {
    return controlPathsForControlFile(baked)
  }
  const key = process.env[ORCH_STEP_KEY_ENV]
  const runStateDir = process.env[ORCH_RUN_STATE_DIR_ENV]
  if (
    key === undefined ||
    key.length === 0 ||
    runStateDir === undefined ||
    runStateDir.length === 0
  ) {
    throw new Error(
      `puppet: no baked controlPath and ${ORCH_STEP_KEY_ENV}/${ORCH_RUN_STATE_DIR_ENV} are unset`,
    )
  }
  return resolveControlPaths({ runStateDir, key })
}

async function runPuppet(script: PuppetScript): Promise<number> {
  const { controlPath, ackDir, readyPath } = resolvePuppetControl(script)
  const interval = script.pollIntervalMs ?? DEFAULT_PUPPET_POLL_INTERVAL_MS
  const fs = new BunFsService()
  const { path } = await import('../../services/types.ts')

  await fs.mkdir(path(nodePath.dirname(controlPath)), { recursive: true })
  await fs.mkdir(path(ackDir), { recursive: true })
  if (!(await fs.exists(path(controlPath)))) {
    await writeFileNode(controlPath, '', 'utf-8')
  }
  // Delete any `.ready` marker already present at spawn, then write a fresh one
  // once idle (below). In Phase 1 each run uses a fresh runId dir with a single
  // attempt per key, so this delete-at-spawn is what keeps a driver from
  // resolving `waitForReady()` against a marker the *current* process did not
  // write. (A future in-run retry/resume that re-ran the same key in the same
  // dir would re-open a spawn-vs-poll window; closing that needs the driver to
  // verify the marker's attempt token — the marker already carries this pid —
  // and is deferred until such a retry path exists.)
  await rm(readyPath, { force: true }).catch(() => {})

  const sink = headlessSink()
  const state: PuppetReaderState = { cursor: 0, lineCounter: 0, buffer: '' }
  let readyWritten = false
  for (;;) {
    if (parentExited()) return 0
    let raw: string
    try {
      raw = await fs.readFile(path(controlPath))
    } catch {
      raw = ''
    }
    if (raw.length > state.cursor) {
      const result = await processPuppetBatch(raw, state, ackDir, sink)
      if (result.kind === 'terminate') return result.exitCode ?? 0
    }
    // Idle-waiting (R13): write the readiness marker once, on first idle.
    // Distinct from `step:start` by construction — a filesystem marker the
    // driver polls, not a lifecycle event. On write failure leave the flag
    // unset so the next tick retries.
    if (!readyWritten) {
      readyWritten = await writeFileNode(readyPath, String(process.pid), 'utf-8')
        .then(() => true)
        .catch(() => false)
    }
    await new Promise((res) => setTimeout(res, interval))
  }
}

async function dispatchPuppetCommand(
  command: PuppetCommand,
  sink: OutputSink,
): Promise<EngineResult> {
  // Cross-mode vocabulary (`type_and_send` / `finish`) routes through the
  // shared engine so the control channel and manual stdin (U4) converge on the
  // same ops and the same sink. Legacy headless commands fall through.
  const engineOp = controlToEngineOp(command)
  if (engineOp !== null) return runEngineOp(engineOp, sink)
  switch (command.cmd) {
    case 'emit':
      writeEvent(command.event)
      return { kind: 'continue' }
    case 'write-file':
      await writeFileNode(command.path, command.content, 'utf-8')
      return { kind: 'continue' }
    case 'run-shell': {
      // Use Bun.spawn for portability; await exit. Output is intentionally
      // discarded — `emit` is the side-channel for test-visible content.
      const proc = Bun.spawn(['sh', '-c', command.command], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      await proc.exited
      return { kind: 'continue' }
    }
    case 'complete': {
      const terminal: TerminalEvent = {
        kind: 'terminal',
        type: 'turn-complete',
        ...(command.structuredOutput !== undefined ? { data: command.structuredOutput } : {}),
      }
      writeEvent(terminal)
      return { kind: 'terminate', exitCode: 0 }
    }
    case 'fail': {
      writeEvent({ kind: 'terminal', type: 'error', message: command.message })
      return { kind: 'terminate', exitCode: command.exitCode ?? 1 }
    }
    case 'wait':
      await new Promise((res) => setTimeout(res, command.ms))
      return { kind: 'continue' }
    default:
      // `type_and_send` / `finish` are handled by the engine above; any other
      // cmd is unreachable given the schema. Satisfy the exhaustiveness check
      // without a silent fall-through.
      return { kind: 'continue' }
  }
}

async function dispatch(script: StepScript): Promise<number> {
  switch (script.kind) {
    case 'instant-ok':
      return runInstantOk(script)
    case 'instant-fail':
      return runInstantFail(script)
    case 'wait-for-file':
      return runWaitForFile(script)
    case 'emit-then-hang':
      return runEmitThenHang(script)
    case 'puppet':
      return runPuppet(script)
  }
}

async function main(): Promise<number> {
  const stepName = process.env[ORCH_LIFECYCLE_STEP_NAME_ENV]
  if (typeof stepName !== 'string' || stepName.length === 0) {
    writeEvent({
      kind: 'terminal',
      type: 'error',
      message: `${ORCH_LIFECYCLE_STEP_NAME_ENV} env var is unset`,
    })
    return 1
  }

  let script: StepScript
  try {
    const fs = new BunFsService()
    const file = await loadScriptedFakeScript({ fs, env: process.env })
    script = resolveStepScript(file, stepName)
  } catch (err) {
    const message =
      err instanceof ScriptLoadError || err instanceof Error ? err.message : String(err)
    writeEvent({ kind: 'terminal', type: 'error', message })
    return 1
  }

  return dispatch(script)
}

try {
  const code = await main()
  process.exit(code)
} catch (err) {
  const message = err instanceof Error ? err.message : String(err)
  writeEvent({ kind: 'terminal', type: 'error', message })
  process.exit(1)
}
