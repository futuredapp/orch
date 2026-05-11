// ---------------------------------------------------------------------------
// steps-view-runner — child process entry point spawned onto the left pane.
// ---------------------------------------------------------------------------
//
// `start-steps-view.ts` (parent) spawns this script via
// `host.runInteractive({ pane: 'left', argv, env })`, handing it the run
// directory + workflow name through a base64-encoded `--opts` argv. The child
// mounts the live `StepsViewModel`, renders `<StepsView>` into the pane's
// TTY, and appends keypress intents to `<stateDir>/tui-intents.ndjson`.
//
// IPC contract: one JSON object per line in `tui-intents.ndjson`.
//   { type: 'enter', stepName }
//   { type: 'follow-live' }
//   { type: 'quit' }
//
// Diagnostic IPC: one JSON object per keypress in `<stateDir>/tui-keys.ndjson`.
// Schema is `StepsViewKeyEvent`. The parent tails this file and forwards
// each line into the session logger's `orch` category (debug-only) — so a
// silent input failure no longer leaves the operator with no audit trail.
//
// On `quit` the child unmounts and exits 0; the parent observes the exit (via
// tmux's `pane-died` hook) and tears down the steps-view orchestration.

import { appendFile } from 'node:fs/promises'
import { render } from 'ink'
import React from 'react'
import { z } from 'zod'
import { BunFsService } from '../../../services/fs/index.ts'
import { path as toPath } from '../../../services/types.ts'
import { FileStateStore, runId as toRunId } from '../../../state/index.ts'
import { StepsView, type StepsViewIntent, type StepsViewKeyEvent } from './steps-view.tsx'
import { createStepsViewModel, type StepsViewState } from './steps-view-model.ts'

// ---------------------------------------------------------------------------
// Argv parsing — `--opts <base64-json>`
// ---------------------------------------------------------------------------

const OptsSchema = z.object({
  /** Absolute path to `<basePath>/<runId>/`. */
  stateDir: z.string().min(1),
  /** Run id — restored to the branded type after parsing. */
  runId: z.string().min(1),
  workflowName: z.string(),
  /** Absolute path to `<stateDir>/tui-intents.ndjson`. */
  intentsPath: z.string().min(1),
  /** Absolute path to `<stateDir>/tui-keys.ndjson` — per-keypress IPC sink.
   *  Optional for backwards compatibility with tests that don't supply it;
   *  when omitted the child skips keypress logging entirely. */
  keysPath: z.string().min(1).optional(),
  /** Absolute path to `<basePath>/`. The state store roots here. */
  basePath: z.string().min(1),
})

type ParsedOpts = z.infer<typeof OptsSchema>

export function parseRunnerArgs(argv: readonly string[]): ParsedOpts {
  let optsRaw: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--opts') {
      optsRaw = argv[i + 1]
      break
    }
  }
  if (optsRaw === undefined) {
    throw new Error('steps-view-runner: missing --opts <base64-json>')
  }
  const json = Buffer.from(optsRaw, 'base64').toString('utf8')
  const parsed = OptsSchema.parse(JSON.parse(json))
  return parsed
}

// ---------------------------------------------------------------------------
// Render — exposed for the unit-test path so the e2e isn't load-bearing.
// ---------------------------------------------------------------------------

export interface RenderRunnerOptions {
  readonly opts: ParsedOpts
  /** Stdout binding. Defaults to `process.stdout` when called from the CLI. */
  readonly stdout?: NodeJS.WriteStream
  /** `true` to skip Ctrl-C → exit (used by tests). Default `false`. */
  readonly exitOnCtrlC?: boolean
  /** When provided, replace `appendFile`. Tests use this to capture writes. */
  readonly writeIntent?: (line: string) => Promise<void>
  /** When provided, replace the model factory. Tests use this. */
  readonly mountedFor?: 'cli' | 'test'
}

export async function runStepsViewRunner(opts: ParsedOpts): Promise<void> {
  const fs = new BunFsService()
  const stateStore = new FileStateStore({ fs, basePath: toPath(opts.basePath) })
  const model = createStepsViewModel({
    stateDir: toPath(opts.stateDir),
    workflowName: opts.workflowName,
    fs,
    stateStore,
    runId: toRunId(opts.runId),
    clock: { now: () => Date.now() },
  })

  const intentsPath = toPath(opts.intentsPath)
  const writeIntent = (intent: StepsViewIntent): Promise<void> =>
    appendFile(intentsPath, `${JSON.stringify(intent)}\n`, 'utf8')

  const keysPath = opts.keysPath !== undefined ? toPath(opts.keysPath) : undefined
  const writeKey = (event: StepsViewKeyEvent): void => {
    if (keysPath === undefined) return
    void appendFile(keysPath, `${JSON.stringify(event)}\n`, 'utf8').catch((err) => {
      process.stderr.write(`[steps-view] key write failed: ${String(err)}\n`)
    })
  }

  await model.start()
  const initial: StepsViewState = model.state() ?? {
    status: 'live',
    run: { runId: opts.runId, workflowName: opts.workflowName, startedAt: 0 },
    steps: [],
    view: { mode: 'live' },
  }

  let resolved = false
  let resolveExit: (() => void) | undefined
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve
  })

  const onIntent = (intent: StepsViewIntent): void => {
    void writeIntent(intent).catch((err) => {
      process.stderr.write(`[steps-view] intent write failed: ${String(err)}\n`)
    })
    if (intent.type === 'quit' && !resolved) {
      resolved = true
      resolveExit?.()
    }
  }

  // The Ink wrapper: a stateful container that keeps the latest StepsViewState
  // in component state and re-renders on every model emission.
  const Container = (): React.ReactElement => {
    const [current, setCurrent] = React.useState<StepsViewState>(initial)
    React.useEffect(() => {
      const handler = (state: StepsViewState): void => {
        setCurrent(state)
      }
      model.on('change', handler)
      return () => {
        model.off('change', handler)
      }
    }, [])
    return React.createElement(StepsView, { state: current, onIntent, onKey: writeKey })
  }

  const instance = render(React.createElement(Container), {
    exitOnCtrlC: false,
    patchConsole: false,
  })

  await Promise.race([exitPromise, instance.waitUntilExit()])
  instance.unmount()
  await model.stop()
}

// ---------------------------------------------------------------------------
// CLI entry — only fires when this file is the script's main module.
// ---------------------------------------------------------------------------

const isDirect = (): boolean => {
  // `import.meta.main` is true under Bun when this file is the entrypoint.
  // Falls back to argv[1] under Node.
  const meta = import.meta as unknown as { readonly main?: boolean }
  if (meta.main === true) return true
  return process.argv[1]?.endsWith('steps-view-runner.tsx') ?? false
}

if (isDirect()) {
  try {
    const opts = parseRunnerArgs(process.argv.slice(2))
    runStepsViewRunner(opts).catch((err) => {
      process.stderr.write(
        `[steps-view-runner] ${err instanceof Error ? err.message : String(err)}\n`,
      )
      process.exit(1)
    })
  } catch (err) {
    process.stderr.write(
      `[steps-view-runner] ${err instanceof Error ? err.message : String(err)}\n`,
    )
    process.exit(1)
  }
}
