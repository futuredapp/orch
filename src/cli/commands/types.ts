// `orch types [--watch]` — runs the sidecar codegen once, or keeps a watch
// loop alive that regenerates on every prompt-file change.
//
// One-shot is plain: load config → runCodegen → print summary → exit.
//
// Watch mode mirrors the established `tail-state-json` pattern: hybrid
// `fs.watch` + 250 ms poll backstop + 50 ms trailing debounce, capped at
// 200 ms max-wait. macOS fs.watch silently drops events under atomic
// renames; the poll backstop catches those, the debounce coalesces bursts.

import { type FSWatcher, watch as fsWatchSync } from 'node:fs'
import type { CodegenError, CodegenResult } from '../../codegen/index.ts'
import { discoverPrompts, runCodegen } from '../../codegen/index.ts'
import { ConfigLoadError, loadConfig, resolvePromptsConfig } from '../../config/index.ts'
import type { WorkflowArgs } from '../../core/index.ts'
import type { FsService } from '../../services/fs/index.ts'
import type { Path } from '../../services/index.ts'
import type { CliDeps } from '../deps.ts'
import { type CliOpts, EXIT } from '../main.ts'

const DEFAULT_POLL_MS = 250
const DEFAULT_TRAILING_MS = 50
const DEFAULT_MAX_DEBOUNCE_MS = 200

export interface TypesCmdOptions {
  /** Override the poll backstop interval. Tests use a shorter value. */
  readonly pollIntervalMs?: number
  /** Override the trailing-debounce window. */
  readonly trailingDebounceMs?: number
  /** Override the max-wait debounce. */
  readonly maxDebounceMs?: number
  /**
   * Resolves when the watch loop should exit cleanly. Tests inject a
   * controlled signal; production wires it to `process.once('SIGINT', …)`.
   */
  readonly stopSignal?: Promise<void>
}

export async function typesCmd(
  deps: CliDeps,
  _positional: string,
  _args: WorkflowArgs,
  opts: CliOpts,
  watchOpts: TypesCmdOptions = {},
): Promise<number> {
  let loaded: Awaited<ReturnType<typeof loadConfig>>
  try {
    loaded = await loadConfig(deps.cwd)
  } catch (err) {
    if (err instanceof ConfigLoadError) {
      writeConfigError(opts, err.message)
      return EXIT.CONFIG_ERROR
    }
    throw err
  }

  const { include, exclude } = resolvePromptsConfig(loaded.config)
  const configDir = loaded.configDir
  const jsonOutput = opts.format === 'json'

  // One-shot pass (always runs, including before the watch loop).
  const initial = await runOnce(deps.fsService, configDir, include, exclude)
  printResult(initial, jsonOutput)

  if (!opts.watch) {
    return initial.errors.length > 0 ? EXIT.STEP_FAILURE : EXIT.OK
  }

  // Watch loop.
  const pollMs = watchOpts.pollIntervalMs ?? DEFAULT_POLL_MS
  const trailingMs = watchOpts.trailingDebounceMs ?? DEFAULT_TRAILING_MS
  const maxDebounceMs = watchOpts.maxDebounceMs ?? DEFAULT_MAX_DEBOUNCE_MS

  await runWatchLoop({
    fs: deps.fsService,
    configDir,
    include,
    exclude,
    pollMs,
    trailingMs,
    maxDebounceMs,
    jsonOutput,
    stopSignal: watchOpts.stopSignal ?? installSigintSignal(),
  })

  return EXIT.OK
}

async function runOnce(
  fs: FsService,
  configDir: Path,
  include: readonly string[],
  exclude: readonly string[],
): Promise<CodegenResult> {
  return runCodegen({ fs }, { configDir, include, exclude })
}

function writeConfigError(opts: CliOpts, message: string): void {
  if (opts.format === 'json') {
    process.stderr.write(`${JSON.stringify({ event: 'config.error', message })}\n`)
    return
  }
  process.stderr.write(`${message}\n`)
}

function printResult(result: CodegenResult, jsonOutput: boolean): void {
  if (jsonOutput) {
    printJson(result)
    return
  }
  printSummary(result)
}

function printJson(result: CodegenResult): void {
  // NDJSON: one event per line. Stdout for written/skipped, stderr for errors —
  // so an agent reading stdout sees a clean success stream and can branch on
  // stderr for failures.
  for (const p of result.written) {
    process.stdout.write(`${JSON.stringify({ event: 'codegen.written', path: p })}\n`)
  }
  for (const p of result.skipped) {
    process.stdout.write(`${JSON.stringify({ event: 'codegen.skipped', path: p })}\n`)
  }
  for (const err of result.errors) {
    process.stderr.write(`${JSON.stringify(formatErrorEvent(err))}\n`)
  }
}

function formatErrorEvent(err: CodegenError): Record<string, unknown> {
  const base: Record<string, unknown> = {
    event: 'codegen.error',
    path: err.path,
    message: err.message,
  }
  if (err.cause !== undefined) base.cause = err.cause
  if (err.missing !== undefined) base.missing = err.missing
  if (err.extra !== undefined) base.extra = err.extra
  return base
}

function printSummary(result: CodegenResult): void {
  const w = result.written.length
  const s = result.skipped.length
  const e = result.errors.length
  // Suppress the summary on a clean idempotent pass (nothing written, no
  // errors) so the watch loop and agent loops that call `orch types`
  // repeatedly stay quiet. `ORCH_QUIET=1` always suppresses, mirroring the
  // codegen prepass in `run.ts`.
  const quiet = process.env.ORCH_QUIET === '1'
  const shouldPrint = !quiet && (w > 0 || e > 0)
  if (shouldPrint) {
    process.stdout.write(`orch types: ${w} written, ${s} skipped, ${e} error(s)\n`)
  }
  for (const err of result.errors) {
    process.stderr.write(`  ! ${err.path}: ${err.message}\n`)
  }
}

interface WatchLoopOptions {
  readonly fs: FsService
  readonly configDir: Path
  readonly include: readonly string[]
  readonly exclude: readonly string[]
  readonly pollMs: number
  readonly trailingMs: number
  readonly maxDebounceMs: number
  readonly jsonOutput: boolean
  readonly stopSignal: Promise<void>
}

// 60-line cap exceeded: hybrid fs.watch + poll backstop + trailing-debounce
// state shares closure state intentionally — extracting it would require
// threading a state object through 4 closures and worsen readability.
async function runWatchLoop(opts: WatchLoopOptions): Promise<void> {
  const watchers = new Map<string, FSWatcher>()
  // mtimeMs of each watched source, updated after every successful fire().
  // The poll backstop schedules a read ONLY when a watched file's mtime
  // diverges from this map (or the desired set membership changes) — without
  // this gate the poll would tick every 250 ms and call runOnce continuously.
  const knownMtimes = new Map<string, number>()
  // Track which files we've already warned about per-error-code so noisy
  // watcher failures don't spam stderr.
  const warnedWatchers = new Set<string>()
  let trailingTimer: NodeJS.Timeout | undefined
  let firstEventAt: number | undefined
  let stopped = false
  let inFlight = false
  let pending = false

  const fire = async (): Promise<void> => {
    if (stopped) return
    if (inFlight) {
      pending = true
      return
    }
    inFlight = true
    try {
      const result = await runOnce(opts.fs, opts.configDir, opts.include, opts.exclude)
      printResult(result, opts.jsonOutput)
      await reconcileWatchers()
      await refreshKnownMtimes()
    } finally {
      inFlight = false
      if (pending && !stopped) {
        pending = false
        await fire()
      }
    }
  }

  const fireSafe = (): void => {
    if (stopped) return
    fire().catch((err) => {
      process.stderr.write(`orch types: watch fire failed: ${describeErr(err)}\n`)
    })
  }

  const scheduleRead = (): void => {
    if (stopped) return
    const now = Date.now()
    if (firstEventAt === undefined) firstEventAt = now
    const elapsed = now - firstEventAt
    if (elapsed >= opts.maxDebounceMs) {
      if (trailingTimer !== undefined) clearTimeout(trailingTimer)
      trailingTimer = undefined
      firstEventAt = undefined
      fireSafe()
      return
    }
    if (trailingTimer !== undefined) clearTimeout(trailingTimer)
    trailingTimer = setTimeout(() => {
      trailingTimer = undefined
      firstEventAt = undefined
      fireSafe()
    }, opts.trailingMs)
    trailingTimer.unref?.()
  }

  const reconcileWatchers = async (): Promise<void> => {
    if (stopped) return
    const sources = await discoverPrompts(opts.fs, opts.configDir, opts.include, opts.exclude)
    const desired = new Set<string>(sources)
    // Drop watchers for sources that disappeared.
    for (const [filePath, watcher] of watchers) {
      if (!desired.has(filePath)) {
        watcher.close()
        watchers.delete(filePath)
        knownMtimes.delete(filePath)
      }
    }
    // Install watchers for new sources.
    for (const filePath of desired) {
      if (watchers.has(filePath)) continue
      try {
        const watcher = fsWatchSync(filePath, () => scheduleRead())
        watcher.on('error', () => {
          watcher.close()
          watchers.delete(filePath)
        })
        watchers.set(filePath, watcher)
      } catch (err) {
        // ENOENT: the source disappeared between discoverPrompts and fs.watch
        // — silently rely on the poll backstop / next reconcile. Other codes
        // (EMFILE / EPERM / ENOSPC) are operator-actionable; warn once per
        // file so a real misconfiguration surfaces in the stderr stream.
        warnWatchFailure(filePath, err)
      }
    }
  }

  const refreshKnownMtimes = async (): Promise<void> => {
    if (stopped) return
    for (const filePath of watchers.keys()) {
      try {
        const s = await opts.fs.stat(filePath as Path)
        knownMtimes.set(filePath, s.mtimeMs)
      } catch {
        knownMtimes.delete(filePath)
      }
    }
  }

  const warnWatchFailure = (filePath: string, err: unknown): void => {
    const code = errCode(err)
    if (code === 'ENOENT') return
    if (warnedWatchers.has(filePath)) return
    warnedWatchers.add(filePath)
    const hint =
      code === 'EMFILE' || code === 'ENOSPC'
        ? ' — reduce the scope of `prompts.include` or raise `ulimit -n`'
        : code === 'EPERM'
          ? ' — file permission denied; check ownership / mode'
          : ''
    process.stderr.write(`orch types: cannot watch ${filePath} (${code ?? 'error'})${hint}\n`)
  }

  // Initial watcher install + mtime snapshot (initial codegen pass already ran above).
  await reconcileWatchers()
  await refreshKnownMtimes()

  const pollTimer: NodeJS.Timeout = setInterval(() => {
    // Poll backstop: only schedule a read when the watched-source set or any
    // file's mtime has diverged from our last-known snapshot. Without this
    // gate the loop would re-run codegen every 250 ms even on an idle tree.
    pollChanged()
      .then((changed) => {
        if (changed) scheduleRead()
      })
      .catch((err) => {
        process.stderr.write(`orch types: poll check failed: ${describeErr(err)}\n`)
      })
  }, opts.pollMs)
  pollTimer.unref?.()

  const pollChanged = async (): Promise<boolean> => {
    if (stopped) return false
    try {
      const sources = await discoverPrompts(opts.fs, opts.configDir, opts.include, opts.exclude)
      const desired = new Set<string>(sources)
      // Membership shift: a file appeared or disappeared since last fire().
      if (desired.size !== knownMtimes.size) return true
      return await anyMtimeDiverged(opts.fs, desired, knownMtimes)
    } catch {
      // Discovery failed transiently — defer to the next tick; do not redraw.
      return false
    }
  }

  await opts.stopSignal
  stopped = true
  if (trailingTimer !== undefined) clearTimeout(trailingTimer)
  clearInterval(pollTimer)
  for (const watcher of watchers.values()) watcher.close()
  watchers.clear()
  knownMtimes.clear()
}

async function anyMtimeDiverged(
  fs: FsService,
  desired: ReadonlySet<string>,
  known: ReadonlyMap<string, number>,
): Promise<boolean> {
  for (const filePath of desired) {
    if (!known.has(filePath)) return true
    try {
      const s = await fs.stat(filePath as Path)
      const prev = known.get(filePath)
      if (prev === undefined || s.mtimeMs !== prev) return true
    } catch {
      // File vanished between discovery and stat — treat as change so the
      // next fire() reconciles cleanly.
      return true
    }
  }
  return false
}

function describeErr(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function errCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const c = (err as { code?: unknown }).code
  return typeof c === 'string' ? c : undefined
}

function installSigintSignal(): Promise<void> {
  // Honor both SIGINT (Ctrl-C) and SIGTERM (systemd/docker/k8s graceful
  // shutdown). Whichever fires first detaches the other so we never leave a
  // dangling listener that would keep the event loop alive.
  return new Promise<void>((resolve) => {
    const handler = (): void => {
      process.off('SIGINT', handler)
      process.off('SIGTERM', handler)
      resolve()
    }
    process.once('SIGINT', handler)
    process.once('SIGTERM', handler)
  })
}
