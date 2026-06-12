import { rename, writeFile } from 'node:fs/promises'
import { render } from 'ink'
import React from 'react'
import { BunProcessService } from '../process/index.ts'
import { paneId, RealTmuxService, socketName } from '../tmux/index.ts'
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
// Distribution: in a dev checkout InkPromptService spawns `bun <abs path to
// this file>` and this module self-executes (see the `isDirect` guard at the
// bottom). In a compiled binary it is bundled into `bin.ts` and reached via
// the `__ask` CLI subcommand instead — it must NOT self-execute there.

interface ParsedArgs {
  readonly spec: PromptSpec
  readonly resultPath: string
}

export function parseAskRunnerArgs(argv: readonly string[]): ParsedArgs {
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

export async function runAskRunner(args: ParsedArgs): Promise<void> {
  const { spec, resultPath } = args

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
  const onFocusPane = focusPaneFromEnv()
  const instance = render(
    React.createElement(AskApp, {
      spec,
      onResolve,
      ...(onFocusPane !== undefined ? { onFocusPane } : {}),
    }),
    {
      exitOnCtrlC: false,
      patchConsole: false,
      alternateScreen: true,
    },
  )

  await instance.waitUntilExit()
  await writePromise
}

// P6 edge-out: when the two-pane host spawned us it injected the tmux socket
// + the steps pane's id (see tmux-host's right-pane interactive spawn). Tab
// past the ask form's last element then hands keyboard focus back to the
// steps pane. Absent env (plain terminals, tests) → undefined → Tab wraps.
function focusPaneFromEnv(): (() => void) | undefined {
  const socket = process.env.ORCH_TMUX_SOCKET
  const target = process.env.ORCH_LEFT_PANE_ID
  if (socket === undefined || socket === '' || target === undefined || target === '') {
    return undefined
  }
  const tmux = new RealTmuxService({ processService: new BunProcessService() })
  return () => {
    void tmux.selectPane({ socket: socketName(socket), target: paneId(target) }).catch((err) => {
      process.stderr.write(`[ink-runner] focus-pane failed: ${String(err)}\n`)
    })
  }
}

// Dev checkout only: `InkPromptService` spawns `bun <abs>/ink-runner.ts`, so
// this file is the process entrypoint and self-executes. In a compiled binary
// it is bundled into `bin.ts` and re-entry is routed explicitly by `main.ts`
// (the `__ask` internal subcommand) — an embedded module's `import.meta.url`
// lives under Bun's virtual FS (`/$bunfs/...`), so it must NOT self-execute
// there (that would hijack the startup of every orch command).
const isDirect = (): boolean => {
  if (import.meta.url.includes('/$bunfs/')) return false
  const meta = import.meta as unknown as { readonly main?: boolean }
  if (meta.main === true) return true
  return process.argv[1]?.endsWith('ink-runner.ts') ?? false
}

if (isDirect()) {
  runAskRunner(parseAskRunnerArgs(process.argv.slice(2))).catch((err) => {
    process.stderr.write(`[ink-runner] ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
}
