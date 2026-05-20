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
 */

import { BunFsService } from '../../services/fs/index.ts'
import type { RunnerEvent, TerminalEvent } from '../types.ts'
import { loadScriptedFakeScript, resolveStepScript, ScriptLoadError } from './script-loader.ts'
import type {
  EmitThenHangScript,
  InstantFailScript,
  InstantOkScript,
  StepScript,
  WaitForFileScript,
} from './types.ts'

const DEFAULT_GATE_POLL_INTERVAL_MS = 50

const ORCH_LIFECYCLE_STEP_NAME_ENV = 'ORCH_LIFECYCLE_STEP_NAME'

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
    if (await fs.exists(gate)) break
    await new Promise((res) => setTimeout(res, interval))
  }

  for (const evt of script.events ?? []) writeEvent(evt)
  writeEvent({ kind: 'terminal', type: 'turn-complete' })
  return 0
}

async function runEmitThenHang(script: EmitThenHangScript): Promise<number> {
  for (const evt of script.events) writeEvent(evt)
  // Block forever — parent will kill via signal. We do NOT emit a terminal
  // event; the script's contract is that orch observes the hang.
  await new Promise<void>(() => {
    /* never resolves */
  })
  return 0
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
