/**
 * drive.ts — DEV-ONLY. The deterministic, ack-gated channel of the QA toolkit:
 * advance a scripted-fake step by appending NDJSON commands to its on-disk
 * control file and blocking on the runner's `.ack` marker. This is how the QA
 * agent says "right pane, emit this line" or "step, you're finished" with zero
 * timing races — never a sleep-as-synchronization.
 *
 * Reuses the SAME `resolveControlPaths` the runner uses, so the path can never
 * drift (mirrors `examples/predictable-tui/drive.ts`, the seed). Unlike that
 * seed, each function here is STATELESS: the next ack sequence number is derived
 * by counting commands already in the control file, so independent `qa send`
 * CLI invocations stay in lockstep without sharing a counter.
 */

import { appendFile, mkdir, readdir, readFile, stat } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { resolveControlPaths } from '../../src/runners/scripted-fake/index.ts'

const POLL_MS = 25
const DEFAULT_TIMEOUT_MS = 15_000

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function pollUntil(pred: () => Promise<boolean>, label: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await pred()) return
    if (Date.now() >= deadline) throw new Error(`qa: timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
}

/** Block until the step's interactive entry has written its `.ready` marker. */
export async function waitForReady(
  runDir: string,
  key: string,
  opts: { readonly timeoutMs?: number } = {},
): Promise<void> {
  const paths = resolveControlPaths({ runStateDir: runDir, key })
  await pollUntil(
    () => fileExists(paths.readyPath),
    `${key} .ready`,
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  )
}

/** Count NDJSON commands already written to the control file (0 if absent). */
async function priorCommandCount(controlPath: string): Promise<number> {
  const existing = await readFile(controlPath, 'utf-8').catch(() => '')
  return existing.split('\n').filter((line) => line.trim().length > 0).length
}

/**
 * Append one command and block until its numbered `.ack` appears. Returns the
 * sequence number that was acked. Callers MUST issue commands to a given step
 * serially (the QA agent does); concurrent sends would race on the count.
 */
async function sendCommand(
  runDir: string,
  key: string,
  cmd: Readonly<Record<string, unknown>>,
  opts: { readonly timeoutMs?: number } = {},
): Promise<number> {
  const paths = resolveControlPaths({ runStateDir: runDir, key })
  await mkdir(paths.controlDir, { recursive: true })
  const seq = (await priorCommandCount(paths.controlPath)) + 1
  await appendFile(paths.controlPath, `${JSON.stringify(cmd)}\n`, 'utf-8')
  await pollUntil(
    () => fileExists(nodePath.join(paths.ackDir, `${seq}.ack`)),
    `${key} ack #${seq}`,
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  )
  return seq
}

/** Make the step emit one line into its (right) pane, ack-gated. */
export async function sendLine(
  runDir: string,
  key: string,
  text: string,
  opts: { readonly timeoutMs?: number } = {},
): Promise<number> {
  return sendCommand(runDir, key, { cmd: 'type_and_send', text }, opts)
}

/**
 * Inverse of the runner's `encodeKey` (`%XXXX` fixed-width hex per unsafe char).
 * Lets the QA agent recover the logical step key from a control filename so it
 * can address subworkflow steps (e.g. `deep-dive>investigate`) without guessing.
 */
function decodeKey(encoded: string): string {
  return encoded.replace(/%([0-9A-Fa-f]{4})/g, (_m, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  )
}

/**
 * List the logical keys of every step that has written a `.ready` marker for
 * this run — i.e. steps that have reached their interactive entry and can be
 * addressed. Decodes the on-disk control filenames so subworkflow step keys
 * surface verbatim. The agent uses this to discover what it can drive next.
 */
export async function listAwaiting(runDir: string): Promise<readonly string[]> {
  const { controlDir } = resolveControlPaths({ runStateDir: runDir, key: 'x' })
  const entries = await readdir(controlDir).catch(() => [] as string[])
  return entries
    .filter((name) => name.endsWith('.ready'))
    .map((name) => decodeKey(name.slice(0, -'.ready'.length)))
    .sort()
}

/** Finish the step with an exit code (default 0), ack-gated. */
export async function finishStep(
  runDir: string,
  key: string,
  code = 0,
  opts: { readonly timeoutMs?: number } = {},
): Promise<number> {
  return sendCommand(runDir, key, { cmd: 'finish', code }, opts)
}
