#!/usr/bin/env bun
/**
 * qa.ts — DEV-ONLY external driver CLI for the `orch-qa-engineer` skill. Drives
 * a running two-pane orch session from the outside so a QA agent can launch a
 * scripted-fake workflow, screenshot the panes, advance steps deterministically,
 * simulate typing, and tear down — all as stateless, turn-by-turn shell calls.
 *
 * The agent launches the run itself (background Bash):
 *   cd examples && bun ../src/cli/main.ts run <wf> --mode=two-pane --no-attach
 * then drives with:
 *   bun qa.ts info --wait          # resolve runId/socket/panes; block until ready
 *   bun qa.ts shot both            # capture left+right → text files
 *   bun qa.ts steps                # structured read of the steps list
 *   bun qa.ts send <step> line "…" # deterministic emit (ack-gated)
 *   bun qa.ts send <step> finish   # deterministic finish (ack-gated)
 *   bun qa.ts keys right "hi" Enter # raw typing into a pane
 *   bun qa.ts focus left           # simulate clicking a pane
 *   bun qa.ts down                 # kill the tmux server
 *
 * Every subcommand resolves the run fresh (newest under `--cwd`/.orch/state, or
 * `--run <id>`), so invocations share no in-process state.
 */

import { mkdir, readdir, writeFile } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { finishStep, listAwaiting, sendLine, waitForReady } from './drive.ts'
import { renderPng, rendererAvailable, renderStackedPng, trimTrailingBlank } from './render.ts'
import { createQaSession, type PaneName, resolveRun, type ResolvedRun } from './session.ts'
import { parseStepsView } from './steps.ts'

interface Flags {
  readonly run?: string
  readonly cwd: string
  readonly raw: boolean
  readonly noPng: boolean
  readonly out?: string
  readonly json: boolean
  readonly wait: boolean
  readonly positionals: readonly string[]
}

function parseFlags(argv: readonly string[]): Flags {
  const positionals: string[] = []
  let run: string | undefined
  let out: string | undefined
  let cwd = process.cwd()
  let raw = false
  let noPng = false
  let json = false
  let wait = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--raw') raw = true
    else if (arg === '--no-png') noPng = true
    else if (arg === '--json') json = true
    else if (arg === '--wait') wait = true
    else if (arg === '--run') run = argv[(i += 1)]
    else if (arg === '--out') out = argv[(i += 1)]
    else if (arg === '--cwd') cwd = argv[(i += 1)] ?? cwd
    else if (arg !== undefined) positionals.push(arg)
  }
  return { run, cwd, raw, noPng, out, json, wait, positionals }
}

function asPane(token: string | undefined): PaneName {
  if (token === 'left' || token === 'right') return token
  throw new Error(`qa: expected pane "left" or "right", got ${JSON.stringify(token)}`)
}

/** Block until the tmux server is up and both panes exist (info --wait). */
async function waitForSession(session: ReturnType<typeof createQaSession>): Promise<void> {
  const deadline = Date.now() + 15_000
  for (;;) {
    const up = await session.hasServer().catch(() => false)
    if (up) {
      const ok = await session
        .resolvePanes()
        .then(() => true)
        .catch(() => false)
      if (ok) return
    }
    if (Date.now() >= deadline) throw new Error('qa: timed out waiting for two-pane session')
    await new Promise((r) => setTimeout(r, 50))
  }
}

/** Allocate the next `NNN-` screenshot index in a directory. */
async function nextIndex(dir: string): Promise<number> {
  const entries = await readdir(dir).catch(() => [] as string[])
  const max = entries.reduce((acc, name) => {
    const n = /^(\d+)-/.exec(name)?.[1]
    return n === undefined ? acc : Math.max(acc, Number(n))
  }, 0)
  return max + 1
}

async function shoot(
  session: ReturnType<typeof createQaSession>,
  run: ResolvedRun,
  flags: Flags,
): Promise<void> {
  const which = flags.positionals[0] ?? 'both'
  const panes: PaneName[] = which === 'both' ? ['left', 'right'] : [asPane(which)]
  const outDir = flags.out ?? nodePath.join(run.runDir, 'qa-screenshots')
  await mkdir(outDir, { recursive: true })
  const idx = String(await nextIndex(outDir)).padStart(3, '0')

  // PNGs are automatic when `freeze` is installed (vision input for color
  // analysis); `--no-png` opts out. The `.ansi` capture is the PNG source.
  const pngOn = !flags.noPng && (await rendererAvailable())
  const wantAnsi = pngOn || flags.raw
  const ansiByPane: Partial<Record<PaneName, string>> = {}

  for (const pane of panes) {
    const text = trimTrailingBlank(await session.capture(pane))
    const txtFile = nodePath.join(outDir, `${idx}-${pane}.txt`)
    await writeFile(txtFile, text, 'utf-8')
    const made: string[] = [txtFile]

    let ansiFile: string | undefined
    if (wantAnsi) {
      const ansi = trimTrailingBlank(await session.capture(pane, { raw: true }))
      ansiByPane[pane] = ansi
      ansiFile = nodePath.join(outDir, `${idx}-${pane}.ansi`)
      await writeFile(ansiFile, ansi, 'utf-8')
      made.push(ansiFile)
    }
    if (pngOn && ansiFile !== undefined) {
      const pngFile = nodePath.join(outDir, `${idx}-${pane}.png`)
      await renderPng({ ansiPath: ansiFile, pngPath: pngFile })
      made.push(pngFile)
    }
    process.stdout.write(`\n===== ${pane} pane → ${made.join(', ')} =====\n${text}\n`)
  }

  // Combined `both.png` so the agent can eyeball the whole TUI in one image.
  const left = ansiByPane.left
  const right = ansiByPane.right
  if (pngOn && which === 'both' && left !== undefined && right !== undefined) {
    const bothPng = await renderStackedPng({ outDir, idx, left, right })
    process.stdout.write(`\n===== both panes (stacked) → ${bothPng} =====\n`)
  }

  if (!pngOn && !flags.noPng) {
    process.stdout.write(
      '\n(note: `freeze` not found — PNGs skipped, text captures only. ' +
        'Install: brew install charmbracelet/tap/freeze)\n',
    )
  }
}

async function showSteps(
  session: ReturnType<typeof createQaSession>,
  flags: Flags,
): Promise<void> {
  const capture = await session.capture('left')
  const parsed = parseStepsView(capture)
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(parsed, null, 2)}\n`)
    return
  }
  for (const s of parsed.steps) {
    const indent = '  '.repeat(s.depth)
    const flag = s.active ? '  ← active' : ''
    process.stdout.write(`${indent}${s.glyph} ${s.name} [${s.status}]${flag}\n`)
  }
  process.stdout.write(
    `\nsubworkflow present: ${parsed.hasSubworkflow}; active: ${parsed.activeStep?.name ?? '(none)'}\n`,
  )
}

const HELP =
  'qa: commands — info [--wait] | shot <left|right|both> [--raw] [--no-png] | steps [--json] | ' +
  'send <step> line "…" | send <step> finish [code] | wait-ready <step> | ' +
  'awaiting [--json] | keys <left|right> <key…> | focus <left|right> | down\n' +
  'flags — --run <id> --cwd <dir> --out <dir>\n' +
  'shot writes <NNN>-<pane>.txt always; .ansi + .png (via freeze) unless --no-png; ' +
  'shot both also writes <NNN>-both.png (panes stacked).\n'

async function main(): Promise<number> {
  const [, , cmd, ...rest] = process.argv

  // Help / unknown commands must not require a live run to resolve.
  if (cmd === undefined || cmd === '--help' || cmd === '-h') {
    process.stdout.write(HELP)
    return 0
  }

  const flags = parseFlags(rest)
  const run = await resolveRun({ cwd: flags.cwd, runId: flags.run })
  const session = createQaSession(run)

  switch (cmd) {
    case 'info': {
      if (flags.wait) await waitForSession(session)
      const panes = await session.resolvePanes().catch(() => undefined)
      process.stdout.write(
        `${JSON.stringify(
          { runId: run.runId, socket: run.socket, runDir: run.runDir, session: 'orch', panes },
          null,
          2,
        )}\n`,
      )
      return 0
    }
    case 'shot':
      await shoot(session, run, flags)
      return 0
    case 'steps':
      await showSteps(session, flags)
      return 0
    case 'send': {
      const step = flags.positionals[0]
      const action = flags.positionals[1]
      if (step === undefined) throw new Error('qa send: missing <step>')
      if (action === 'line') {
        const text = flags.positionals[2] ?? ''
        await sendLine(run.runDir, step, text)
        process.stdout.write(`qa: ${step} ← ${JSON.stringify(text)} (acked)\n`)
      } else if (action === 'finish') {
        const code = flags.positionals[2] === undefined ? 0 : Number(flags.positionals[2])
        await finishStep(run.runDir, step, code)
        process.stdout.write(`qa: ${step} finished (code ${code}, acked)\n`)
      } else {
        throw new Error(`qa send: expected "line" or "finish", got ${JSON.stringify(action)}`)
      }
      return 0
    }
    case 'wait-ready': {
      const step = flags.positionals[0]
      if (step === undefined) throw new Error('qa wait-ready: missing <step>')
      await waitForReady(run.runDir, step)
      process.stdout.write(`qa: ${step} ready\n`)
      return 0
    }
    case 'awaiting': {
      const keys = await listAwaiting(run.runDir)
      process.stdout.write(flags.json ? `${JSON.stringify(keys)}\n` : `${keys.join('\n')}\n`)
      return 0
    }
    case 'keys': {
      const pane = asPane(flags.positionals[0])
      const keys = flags.positionals.slice(1)
      if (keys.length === 0) throw new Error('qa keys: missing key(s)')
      for (const key of keys) await session.sendKey(pane, key)
      process.stdout.write(`qa: sent ${keys.length} key(s) to ${pane}\n`)
      return 0
    }
    case 'focus': {
      const pane = asPane(flags.positionals[0])
      await session.focus(pane)
      process.stdout.write(`qa: focused ${pane}\n`)
      return 0
    }
    case 'down':
      await session.killServer()
      process.stdout.write(`qa: tmux server killed (${run.socket})\n`)
      return 0
    default:
      process.stderr.write(`qa: unknown command ${JSON.stringify(cmd)}\n${HELP}`)
      return 1
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`qa: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
