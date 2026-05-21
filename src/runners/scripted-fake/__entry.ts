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

import { writeFile as writeFileNode } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { BunFsService } from '../../services/fs/index.ts'
import type { RunnerEvent, TerminalEvent } from '../types.ts'
import { loadScriptedFakeScript, resolveStepScript, ScriptLoadError } from './script-loader.ts'
import {
  type EmitThenHangScript,
  type InstantFailScript,
  type InstantOkScript,
  type PuppetCommand,
  PuppetCommandSchema,
  type PuppetScript,
  type StepScript,
  type WaitForFileScript,
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

interface BatchResult {
  readonly kind: 'continue' | 'terminate'
  readonly exitCode?: number
}

async function processPuppetBatch(
  raw: string,
  state: PuppetReaderState,
  ackDir: string,
): Promise<BatchResult> {
  state.buffer += raw.slice(state.cursor)
  state.cursor = raw.length
  const lines = state.buffer.split('\n')
  state.buffer = lines.pop() ?? ''
  for (const line of lines) {
    if (line.trim().length === 0) continue
    const parsed = parsePuppetCommand(line)
    if (parsed.kind === 'error') {
      writeEvent({
        kind: 'terminal',
        type: 'error',
        message: `puppet: bad command on line ${state.lineCounter}: ${parsed.message}`,
      })
      return { kind: 'terminate', exitCode: 1 }
    }
    state.lineCounter += 1
    const outcome = await dispatchPuppetCommand(parsed.value)
    await writePuppetAck(ackDir, state.lineCounter, outcome)
    if (outcome.kind === 'terminate') return { kind: 'terminate', exitCode: outcome.exitCode }
  }
  return { kind: 'continue' }
}

async function runPuppet(script: PuppetScript): Promise<number> {
  const controlPath = script.controlPath
  const interval = script.pollIntervalMs ?? DEFAULT_PUPPET_POLL_INTERVAL_MS
  const ackDir = `${controlPath}.acks`
  const fs = new BunFsService()
  const { path } = await import('../../services/types.ts')

  await fs.mkdir(path(nodePath.dirname(controlPath)), { recursive: true })
  await fs.mkdir(path(ackDir), { recursive: true })
  if (!(await fs.exists(path(controlPath)))) {
    await writeFileNode(controlPath, '', 'utf-8')
  }

  const state: PuppetReaderState = { cursor: 0, lineCounter: 0, buffer: '' }
  for (;;) {
    let raw: string
    try {
      raw = await fs.readFile(path(controlPath))
    } catch {
      raw = ''
    }
    if (raw.length > state.cursor) {
      const result = await processPuppetBatch(raw, state, ackDir)
      if (result.kind === 'terminate') return result.exitCode ?? 0
    }
    await new Promise((res) => setTimeout(res, interval))
  }
}

interface PuppetTerminate {
  readonly kind: 'terminate'
  readonly exitCode: number
}
interface PuppetContinue {
  readonly kind: 'continue'
}
type PuppetOutcome = PuppetTerminate | PuppetContinue

async function dispatchPuppetCommand(command: PuppetCommand): Promise<PuppetOutcome> {
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
  }
}

type ParseResult =
  | { readonly kind: 'ok'; readonly value: PuppetCommand }
  | { readonly kind: 'error'; readonly message: string }

function parsePuppetCommand(line: string): ParseResult {
  let json: unknown
  try {
    json = JSON.parse(line)
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    return { kind: 'error', message: `invalid JSON (${reason})` }
  }
  const parsed = PuppetCommandSchema.safeParse(json)
  if (!parsed.success) {
    const summary = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    return { kind: 'error', message: `schema (${summary})` }
  }
  return { kind: 'ok', value: parsed.data }
}

async function writePuppetAck(ackDir: string, seq: number, outcome: PuppetOutcome): Promise<void> {
  const filePath = nodePath.join(ackDir, `${seq}.ack`)
  const body = outcome.kind === 'terminate' ? `terminate:${outcome.exitCode}` : 'continue'
  await writeFileNode(filePath, body, 'utf-8').catch(() => {
    /* ack failures are non-fatal — tests poll the ack dir and time out cleanly */
  })
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
