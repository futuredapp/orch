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
 *     bun examples/predictable-tui/drive.ts            # newest run
 *     bun examples/predictable-tui/drive.ts <runDir>   # a specific run dir
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
// the lines to "type" before finishing. Edit this to script a different run.
const SCRIPT: ReadonlyArray<{ readonly key: string; readonly lines: readonly string[] }> = [
  { key: 'plan', lines: ['draft: split the work into two passes'] },
  { key: 'execute', lines: ['pass 1 done', 'pass 2 done'] },
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

/** Drive one step: wait for readiness, send each line, then finish. */
async function driveStep(runStateDir: string, key: string, lines: readonly string[]): Promise<void> {
  const paths = resolveControlPaths({ runStateDir, key })
  await pollUntil(() => fileExists(paths.readyPath), `${key} .ready`)
  await mkdir(paths.controlDir, { recursive: true })

  let seq = 0
  const send = async (cmd: Readonly<Record<string, unknown>>): Promise<void> => {
    seq += 1
    const localSeq = seq
    await appendFile(paths.controlPath, `${JSON.stringify(cmd)}\n`, 'utf-8')
    await pollUntil(
      () => fileExists(nodePath.join(paths.ackDir, `${localSeq}.ack`)),
      `${key} ack #${localSeq}`,
    )
  }

  for (const text of lines) {
    await send({ cmd: 'type_and_send', text })
    process.stderr.write(`drive: ${key} ← ${JSON.stringify(text)}\n`)
  }
  await send({ cmd: 'finish' })
  process.stderr.write(`drive: ${key} finished\n`)
}

async function main(): Promise<void> {
  const runStateDir = process.argv[2] ?? (await newestRunDir())
  process.stderr.write(`drive: targeting ${runStateDir}\n`)
  for (const { key, lines } of SCRIPT) {
    await driveStep(runStateDir, key, lines)
  }
  process.stderr.write('drive: all steps driven\n')
}

await main()
