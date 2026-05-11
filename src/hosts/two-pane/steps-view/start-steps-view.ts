// ---------------------------------------------------------------------------
// startStepsView — parent-side factory for the steps-view daemon.
// ---------------------------------------------------------------------------
//
// Spawns the Ink child onto the left pane via `host.runInteractive({ pane:
// 'left', ... })`, records `intentsStartOffset = stat(intentsPath).size` so
// stale lines from a prior invocation aren't replayed, watches
// `tui-intents.ndjson` via `tail-ndjson`, and dispatches each parsed `Intent`
// to the caller-provided handler.
//
// Failure mode (no watchdog): if the Ink child exits before `stop()` is
// called, append a `tui-crashed` lifecycle record and write the canonical
// "TUI unavailable" message to the left pane via `PaneQueue`. The live run
// in window 0 is unaffected.

import { stat as fsStat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { stepName as toStepName } from '../../../core/types.ts'
import { orchLog, type SessionLogger } from '../../../observability/index.ts'
import { mergeEnv } from '../../../services/process/index.ts'
import type { PaneId, SocketName, TmuxService } from '../../../services/tmux/index.ts'
import { type Path, path as toPath } from '../../../services/types.ts'
import type { RunId } from '../../../state/index.ts'
import type { Host } from '../../host.ts'
import type { PaneQueue } from '../pane-queue.ts'
import { type TailNdjsonHandle, tailNdjson } from './tail-ndjson.ts'

// ---------------------------------------------------------------------------
// Intent schema — matches the child's writer in `steps-view-runner.tsx`.
// ---------------------------------------------------------------------------

export const StepsIntentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('enter'), stepName: z.string().min(1) }),
  z.object({ type: z.literal('follow-live') }),
  z.object({ type: z.literal('quit') }),
  z.object({ type: z.literal('dismiss-banner') }),
])

export type StepsIntent = z.infer<typeof StepsIntentSchema>

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface StartStepsViewOptions {
  readonly host: Host
  /** Tmux primitives for the failure-pane write. */
  readonly tmux: TmuxService
  readonly socket: SocketName
  readonly leftPaneId: PaneId
  readonly paneQueue: PaneQueue
  readonly stateDir: Path
  readonly basePath: Path
  readonly runId: RunId
  readonly workflowName: string
  readonly cwd: Path
  /** Subprocess env. The child must inherit ANTHROPIC_API_KEY etc. for the
   *  resume launcher (Phase 3) to work, but in Phase 1 the child only reads
   *  state files — env is still threaded so existing instrumentation stays
   *  uniform. */
  readonly env: Readonly<Record<string, string>>
  readonly stderr: NodeJS.WritableStream
  readonly logger?: SessionLogger
  readonly onIntent?: (intent: StepsIntent) => void
  /** Override the bun exec path. Default `process.execPath`. */
  readonly bunExecPath?: string
  /** Override the runner script path. Default
   *  `<this dir>/steps-view-runner.tsx` resolved via `import.meta.url`. */
  readonly runnerScript?: Path
}

export interface StartStepsViewHandle {
  /** Resolves once teardown completes. Idempotent. */
  stop(): Promise<void>
  /** True once the parent has fired its first non-stale intent. */
  readonly intentsStartOffset: number
}

const STEP_NAME = toStepName('tui-steps-view')
const TUI_UNAVAILABLE = 'TUI unavailable — detach + reattach to retry, run continues\r\n'

export async function startStepsView(opts: StartStepsViewOptions): Promise<StartStepsViewHandle> {
  const intentsPath = toPath(`${opts.stateDir}/tui-intents.ndjson`)
  const keysPath = toPath(`${opts.stateDir}/tui-keys.ndjson`)

  // Record the starting offset so intents from a prior run-id session (or a
  // crashed-then-restarted parent) are not re-dispatched.
  let intentsStartOffset = 0
  try {
    const stats = await fsStat(intentsPath)
    intentsStartOffset = stats.size
  } catch {
    intentsStartOffset = 0
  }

  let keysStartOffset = 0
  try {
    const stats = await fsStat(keysPath)
    keysStartOffset = stats.size
  } catch {
    keysStartOffset = 0
  }

  const optsForChild = {
    stateDir: String(opts.stateDir),
    runId: String(opts.runId),
    workflowName: opts.workflowName,
    intentsPath: String(intentsPath),
    keysPath: String(keysPath),
    basePath: String(opts.basePath),
  }
  const optsB64 = Buffer.from(JSON.stringify(optsForChild), 'utf8').toString('base64')
  const runnerScript = opts.runnerScript ?? defaultRunnerScript()
  const bunExecPath = opts.bunExecPath ?? process.execPath
  const argv = [bunExecPath, runnerScript as string, '--opts', optsB64]
  const env = mergeEnv(opts.env, {}, {})

  // Tail intent file starting at the recorded offset (`startAtEnd: true`).
  // This makes any pre-existing lines (left over from a crashed prior session)
  // invisible to our handler — only intents written after the parent
  // initialized this tailer are dispatched.
  let stopped = false

  const intentTail: TailNdjsonHandle = tailNdjson({
    filePath: intentsPath,
    startOffset: intentsStartOffset,
    onLine: (line) => {
      const raw = safeJsonParse(line)
      const parsed = StepsIntentSchema.safeParse(raw)
      if (!parsed.success) {
        // Currently silent — surface to the run's lifecycle log so a
        // malformed line (e.g. partial write) is investigable after the fact.
        void opts.logger
          ?.append('lifecycle', { type: 'tui-intent-parse-error', line })
          .catch(() => {})
        return
      }
      // Always-on lifecycle entry: every parent-side intent receipt is
      // logged here. Pairs with the controller's `replay-intent` /
      // `replay-window-*` entries to make the dispatch chain auditable.
      void opts.logger
        ?.append('lifecycle', { type: 'tui-intent', intent: parsed.data })
        .catch(() => {})
      // Phase 4: a `quit` intent precedes the child's clean exit. Marking
      // `stopped` here means the subsequent runInteractive resolution is
      // treated as expected, so the canonical "TUI unavailable" failure
      // message does not fire on a planned quit.
      if (parsed.data.type === 'quit') stopped = true
      opts.onIntent?.(parsed.data)
    },
  })

  // Diagnostic: tail per-keypress IPC so the parent can write keystrokes to
  // the debug-only `orch.ndjson` channel. Helpful when a key seems "stuck" /
  // "ignored" — without this, the Ink child's input is invisible to anyone
  // reading the run's logs.
  const keyTail: TailNdjsonHandle = tailNdjson({
    filePath: keysPath,
    startOffset: keysStartOffset,
    onLine: (line) => {
      const parsed = safeJsonParse(line)
      if (parsed === undefined || typeof parsed !== 'object') return
      orchLog(opts.logger, 'tui-key', parsed as Readonly<Record<string, unknown>>)
    },
  })

  // Spawn child; do not await — we want startStepsView to return synchronously
  // once the child is launched. The exit promise drives the failure path.
  const childExitPromise = opts.host
    .runInteractive({
      argv,
      env,
      cwd: opts.cwd,
      stepName: STEP_NAME,
      pane: 'left',
    })
    .then(
      (result) => {
        if (stopped) return
        void opts.logger
          ?.append('lifecycle', {
            type: 'tui-crashed',
            exitCode: result.exitCode,
            durationMs: result.durationMs,
          })
          .catch(() => {})
        void opts.paneQueue
          .enqueue(opts.leftPaneId, () =>
            opts.tmux.sendKeys({
              socket: opts.socket,
              target: opts.leftPaneId,
              keys: [TUI_UNAVAILABLE],
            }),
          )
          .catch((err) => {
            opts.stderr.write(`[orch tui] ${String(err)}\n`)
          })
      },
      (err) => {
        if (stopped) return
        opts.stderr.write(`[orch tui] runInteractive failed: ${String(err)}\n`)
      },
    )

  await intentTail.start()
  await keyTail.start()

  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    await intentTail.stop()
    await keyTail.stop()
    // Don't await the child exit — teardown happens regardless of whether the
    // child has exited yet (tmux killSession will end it).
    void childExitPromise
  }

  return {
    stop,
    intentsStartOffset,
  }
}

function defaultRunnerScript(): Path {
  const thisFile = fileURLToPath(import.meta.url)
  return toPath(join(dirname(thisFile), 'steps-view-runner.tsx'))
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}
