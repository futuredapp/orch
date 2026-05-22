import { rename, writeFile } from 'node:fs/promises'
import { render } from 'ink'
import React from 'react'
import { AskApp } from './ink-app.tsx'
import type { PromptResult, PromptSpec } from './prompt-service.ts'

// ---------------------------------------------------------------------------
// ink-runner — child process entry point spawned by InkPromptService.
// ---------------------------------------------------------------------------
//
// Mounts AskApp in the controlling TTY (the tmux right pane respawned via
// `host.runInteractive`), reads PromptSpec from `--spec <base64-json>`,
// writes the resolved PromptResult to `--result <abs-path>` atomically on
// submit/cancel, then unmounts and exits 0. Exits 1 on usage error.
//
// IPC contract (parent ↔ child):
//   • spec    — base64 JSON in argv (avoids shell escaping headaches)
//   • result  — absolute path to a file the parent has reserved; written
//               via temp-file + rename so a partial write can never be
//               read as a complete result.
//
// TODO(distribution): v1 ships as checkout-only — InkPromptService spawns
// `bun <abs path to this file>`. Before publishing orch as a binary, give
// this script a `bin` entry in package.json so it resolves under
// `npm install -g`. Tracked in phase 18b's DoD.

interface ParsedArgs {
  readonly spec: PromptSpec
  readonly resultPath: string
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let specRaw: string | undefined
  let resultPath: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--spec') {
      specRaw = argv[i + 1]
      i++
    } else if (a === '--result') {
      resultPath = argv[i + 1]
      i++
    }
  }
  if (specRaw === undefined) throw new Error('ink-runner: missing --spec arg')
  if (resultPath === undefined) throw new Error('ink-runner: missing --result arg')
  const json = Buffer.from(specRaw, 'base64').toString('utf8')
  const spec = JSON.parse(json) as PromptSpec
  return { spec, resultPath }
}

async function writeResultAtomically(path: string, result: PromptResult): Promise<void> {
  const tmp = `${path}.tmp`
  await writeFile(tmp, JSON.stringify(result), 'utf8')
  await rename(tmp, path)
}

async function main(): Promise<void> {
  const { spec, resultPath } = parseArgs(process.argv.slice(2))

  let writePromise: Promise<void> = Promise.resolve()

  const onResolve = (r: PromptResult): void => {
    // Resolve the parent before unmounting so the result file exists by the
    // time the parent's runInteractive returns. AskApp itself guards against
    // double-resolve; this is just the I/O leg.
    writePromise = writeResultAtomically(resultPath, r)
    writePromise.finally(() => {
      instance.unmount()
    })
  }

  // `alternateScreen: true` is load-bearing: tmux's smart-wheel binding from
  // session-init.ts enters `copy-mode -e` on a wheel-up when the pane's
  // `alternate_on` flag is 0. Without alt-screen the prompt UI would slip
  // under the scrollback view on the first wheel-up — see incident
  // r-2026-05-22-212450-07. Matches the steps-view child's render options.
  const instance = render(React.createElement(AskApp, { spec, onResolve }), {
    exitOnCtrlC: false,
    patchConsole: false,
    alternateScreen: true,
  })

  await instance.waitUntilExit()
  await writePromise
}

main().catch((err) => {
  process.stderr.write(`[ink-runner] ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
