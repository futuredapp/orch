#!/usr/bin/env bun
/**
 * drive.ts — DEV-ONLY external driver for the `predictable-tui` example.
 *
 * This is the script half of the predictable fake's two-channel input: instead
 * of a human typing into each pane, it appends NDJSON commands to each step's
 * on-disk control file. It is the seed for a future automation skill (launch
 * orch → screenshot → drive predictable-agent actions) — every action here is
 * something such a skill would issue.
 *
 * It reuses the SAME `resolveControlPaths` the runner uses, so the control-file
 * path can never drift between driver and runner. Run it in a second terminal
 * AFTER launching the workflow (every step is interactive, so no env is needed):
 *
 *     bunx orch run predictable-tui --mode=two-pane
 *     # then, elsewhere:
 *     bun examples/predictable-tui/drive.ts            # newest run (happy path)
 *     bun examples/predictable-tui/drive.ts <runDir>   # a specific run dir
 *     bun examples/predictable-tui/drive.ts --fail     # SIMULATE a failure
 *
 * With `--fail`, the `execute` step is driven to send the `fail` command (the
 * same thing typing `fail` into the pane does) instead of finishing cleanly —
 * the runner exits non-zero, the host recovers the code, and the run lands in
 * the `failed` state (visible in the steps view and `.orch/state/<id>/state.json`).
 *
 * Every send is gated on a durable on-disk signal (the step's `.ready` marker,
 * then each command's `.ack`) — never a timer — so the driver stays in lockstep
 * with the run with no sleeps-as-synchronization.
 */

import { appendFile, mkdir, readdir, stat } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { resolveControlPaths } from '../../src/runners/scripted-fake/index.ts'
import { RUN_ID_PATTERN } from '../../src/state/index.ts'

const STATE_BASE = nodePath.join(process.cwd(), '.orch', 'state')
const POLL_MS = 25
const TIMEOUT_MS = 15_000

// The scripted dialogue: same step keys (`as:`) the workflow assigns, each with
// the lines to "type" before finishing. A step may instead carry `failWith` —
// the simulated-failure message sent via the `fail` command (only when this
// driver runs with `--fail`). Edit this to script a different run.
interface ScriptedStep {
  readonly key: string
  readonly lines: readonly string[]
  /** When set AND `--fail` is passed, send `fail` with this message after the lines. */
  readonly failWith?: string
}

const SCRIPT: readonly ScriptedStep[] = [
  { key: 'plan', lines: ['draft: split the work into two passes'] },
  { key: 'execute', lines: ['pass 1 done'], failWith: 'simulated failure: pass 2 crashed' },
  { key: 'report', lines: ['2 passes, 0 failures'] },
]

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function pollUntil(pred: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS
  for (;;) {
    if (await pred()) return
    if (Date.now() >= deadline) throw new Error(`drive: timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
}

/** Newest run dir under `.orch/state` (RunIds are time-sortable). */
async function newestRunDir(): Promise<string> {
  const entries = await readdir(STATE_BASE).catch(() => [] as string[])
  const runs = entries.filter((e) => RUN_ID_PATTERN.test(e)).sort()
  const newest = runs.at(-1)
  if (newest === undefined) {
    throw new Error(`drive: no runs found under ${STATE_BASE} — launch the workflow first`)
  }
  return nodePath.join(STATE_BASE, newest)
}

/**
 * Drive one step: wait for readiness, send each line, then terminate. Returns
 * `'failed'` when it sent a `fail` command (the run ends here), else `'ok'`.
 */
async function driveStep(runStateDir: string, step: ScriptedStep, failMode: boolean): Promise<'ok' | 'failed'> {
  const paths = resolveControlPaths({ runStateDir, key: step.key })
  await pollUntil(() => fileExists(paths.readyPath), `${step.key} .ready`)
  await mkdir(paths.controlDir, { recursive: true })

  let seq = 0
  const send = async (cmd: Readonly<Record<string, unknown>>): Promise<void> => {
    seq += 1
    const localSeq = seq
    await appendFile(paths.controlPath, `${JSON.stringify(cmd)}\n`, 'utf-8')
    await pollUntil(
      () => fileExists(nodePath.join(paths.ackDir, `${localSeq}.ack`)),
      `${step.key} ack #${localSeq}`,
    )
  }

  for (const text of step.lines) {
    await send({ cmd: 'type_and_send', text })
    process.stderr.write(`drive: ${step.key} ← ${JSON.stringify(text)}\n`)
  }

  if (failMode && step.failWith !== undefined) {
    await send({ cmd: 'fail', message: step.failWith })
    process.stderr.write(`drive: ${step.key} ✗ FAILED (${step.failWith})\n`)
    return 'failed'
  }

  await send({ cmd: 'finish' })
  process.stderr.write(`drive: ${step.key} finished\n`)
  return 'ok'
}

async function main(): Promise<void> {
  const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  const failMode = process.argv.includes('--fail')
  const runStateDir = positional[0] ?? (await newestRunDir())
  process.stderr.write(`drive: targeting ${runStateDir}${failMode ? ' (--fail)' : ''}\n`)
  for (const step of SCRIPT) {
    const outcome = await driveStep(runStateDir, step, failMode)
    if (outcome === 'failed') {
      // The run ends on the failed step — later steps never become ready, so
      // stop here instead of timing out waiting for their `.ready` marker.
      process.stderr.write('drive: run ended in the failed state — stopping\n')
      return
    }
  }
  process.stderr.write('drive: all steps driven\n')
}

await main()
