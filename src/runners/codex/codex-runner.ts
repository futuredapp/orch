// **File size.** This file exceeds the project's 300-LOC warning cap: it carries
// the Codex CLI adapter end to end — schemas, denylist, NDJSON parser, version
// preflight, both argv builders, the factory, post-spawn session-id capture, and
// the auto-stop CODEX_HOME injection. These are one adapter's cohesive concerns;
// splitting for size alone would scatter them. Revisit if a new capability lands.

import { homedir } from 'node:os'
import { z } from 'zod'
import type { FsService } from '../../services/fs/fs-service.ts'
import { BunFsService, BunProcessService, mergeEnv } from '../../services/index.ts'
import type { ProcessService } from '../../services/process/process-service.ts'
import { type Path, path } from '../../services/types.ts'
import type {
  AutoStopPreparation,
  CaptureHandle,
  CaptureResult,
  CaptureSessionIdContext,
  RunnerCommand,
  RunnerContext,
  RunnerEvent,
  TerminalEvent,
} from '../types.ts'
import { defineRunner } from '../types.ts'
import { captureCodexThreadId, resolveCodexSessionsRoot } from './capture-thread-id.ts'
import { toCodexTranscriptLines } from './format-event.ts'

// Section order: schemas, types, denylist, parser, version preflight, factory.

// ---------------------------------------------------------------------------
// Zod schemas — terminal events only (forward-compatible with new event types)
// ---------------------------------------------------------------------------

const CodexTurnCompleted = z
  .object({
    type: z.literal('turn.completed'),
    usage: z
      .object({
        input_tokens: z.number(),
        output_tokens: z.number(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

const CodexTurnFailed = z
  .object({
    type: z.literal('turn.failed'),
    error: z.object({ message: z.string() }).passthrough(),
  })
  .passthrough()

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

type SandboxMode = 'full-auto' | 'read-only' | 'workspace-write' | 'danger-full-access'

export interface CodexOptions {
  readonly model?: string
  readonly sandbox?: SandboxMode
  readonly flags?: readonly string[]
}

// ---------------------------------------------------------------------------
// Flag denylist
// ---------------------------------------------------------------------------

const CODEX_FLAG_DENYLIST = [
  '--dangerously-bypass-approvals-and-sandbox',
  '--yolo',
  '--config',
  '--sandbox',
  '-c',
  '--approval-mode',
] as const

function assertFlagAllowed(flag: string): void {
  for (const deny of CODEX_FLAG_DENYLIST) {
    if (flag === deny || flag.startsWith(`${deny}=`)) {
      throw new Error(`codex(): flag "${flag}" is on the denylist`)
    }
  }
}

const BYPASS_HOOK_TRUST_FLAG = '--dangerously-bypass-hook-trust' as const

function includesFlag(flags: readonly string[] | undefined, flag: string): boolean {
  return flags?.includes(flag) ?? false
}

// ---------------------------------------------------------------------------
// Standalone NDJSON parser — exported for direct unit testing
// ---------------------------------------------------------------------------

function parseTerminalEvent(obj: Record<string, unknown>): RunnerEvent | null {
  if (obj.type === 'turn.completed') {
    const result = CodexTurnCompleted.safeParse(obj)
    return { kind: 'terminal', type: 'turn-complete', data: result.success ? result.data : obj }
  }

  if (obj.type === 'turn.failed') {
    const result = CodexTurnFailed.safeParse(obj)
    const message = result.success ? result.data.error.message : 'unknown error'
    return { kind: 'terminal', type: 'error', message, data: obj }
  }

  if (obj.type === 'error') {
    const message = typeof obj.message === 'string' ? obj.message : 'unknown error'
    return { kind: 'terminal', type: 'error', message, data: obj }
  }

  return null
}

export function parseCodexLine(line: string): RunnerEvent | null {
  const trimmed = line.trim()
  if (trimmed === '') return null

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (err: unknown) {
    if (err instanceof SyntaxError) return null
    throw err
  }

  if (typeof parsed !== 'object' || parsed === null) return null

  const obj = parsed as Record<string, unknown>
  if (typeof obj.type !== 'string') return null

  const terminal = parseTerminalEvent(obj)
  if (terminal) return terminal

  // Surface the thread.started line as a `session-started` info event so the
  // workflow executor (and downstream consumers) capture Codex's `thread_id`
  // through the same shape Claude exposes via system-init. The original
  // payload is preserved verbatim so format-event.ts can still suppress it.
  if (obj.type === 'thread.started' && typeof obj.thread_id === 'string') {
    return {
      kind: 'info',
      type: 'session-started',
      payload: { sessionId: obj.thread_id, ...obj },
    }
  }

  return {
    kind: 'info',
    type: obj.type,
    payload: obj as Readonly<Record<string, unknown>>,
  }
}

// ---------------------------------------------------------------------------
// Version preflight
// ---------------------------------------------------------------------------

const MIN_CODEX_VERSION = '0.118.0'

export class CodexVersionError extends Error {
  constructor(found: string, required: string) {
    super(
      `codex CLI version ${found} is too old. ` +
        `orch requires >= ${required}. ` +
        `Upgrade with: npm i -g @openai/codex`,
    )
    this.name = 'CodexVersionError'
  }
}

function parseVersionTriple(raw: string): [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(raw)
  if (!match) return null
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) return null
  return [major, minor, patch]
}

function versionSatisfies(
  found: [number, number, number],
  required: [number, number, number],
): boolean {
  if (found[0] !== required[0]) return found[0] > required[0]
  if (found[1] !== required[1]) return found[1] > required[1]
  return found[2] >= required[2]
}

async function checkCodexVersion(ps: ProcessService): Promise<void> {
  const which = Bun.which('codex')
  if (!which) {
    throw new CodexVersionError('not found', MIN_CODEX_VERSION)
  }

  const handle = ps.spawn({
    argv: ['codex', '--version'],
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    cwd: path('/tmp'),
  })

  let firstLine = ''
  for await (const line of handle.stdout) {
    if (!firstLine) firstLine = line
  }

  await handle.wait()
  const found = parseVersionTriple(firstLine)
  if (!found) {
    throw new CodexVersionError(firstLine || 'unknown', MIN_CODEX_VERSION)
  }

  const required = parseVersionTriple(MIN_CODEX_VERSION)
  if (required && !versionSatisfies(found, required)) {
    throw new CodexVersionError(`${found[0]}.${found[1]}.${found[2]}`, MIN_CODEX_VERSION)
  }
}

// ---------------------------------------------------------------------------
// Argv builders
// ---------------------------------------------------------------------------
//
// Interactive vs autonomous share **nothing** — different subcommand
// (`codex` vs `codex exec`), different flag matrices (e.g. `--json` is
// exec-only; `--ask-for-approval` is interactive-only), different output
// shapes. Each mode gets its own builder; `buildCommand` dispatches.

function buildInteractiveArgv(
  ctx: RunnerContext,
  opts: { model?: string; sandbox: SandboxMode; flags?: readonly string[] },
): readonly string[] {
  const argv: string[] = ['codex']
  if (opts.sandbox === 'full-auto') argv.push('--full-auto')
  else argv.push('--sandbox', opts.sandbox)
  if (opts.model) argv.push('-m', opts.model)
  // `--no-alt-screen` is the interactive-only switch that gives the user a
  // flat-buffer Codex — composes with the smart-wheel binding's copy-mode
  // entry on the right pane (see docs/plans/2026-05-21-001-feat-scrollable-
  // two-pane-plan.md U3). Always available on the pinned MIN_CODEX_VERSION
  // (0.118.0 >> 0.81.0-alpha.1 where the flag landed). Idempotent if the
  // user supplies it again via flags/extraArgs — Codex accepts the repeat.
  argv.push('--no-alt-screen')
  // TODO(docs/issues/2026-05-26-codex-tui-ignores-hook-trust-bypass.md): this
  // flag is a no-op in the Codex TUI for v0.131–0.133 (upstream bug, fixed by
  // PR #24317, not yet released) — the startup hook-review prompt still appears.
  // Wiring is correct; bump MIN_CODEX_VERSION once the fix ships, no argv change.
  if (
    ctx.autoStop === true &&
    !includesFlag(opts.flags, BYPASS_HOOK_TRUST_FLAG) &&
    !ctx.extraArgs.includes(BYPASS_HOOK_TRUST_FLAG)
  ) {
    argv.push(BYPASS_HOOK_TRUST_FLAG)
  }
  argv.push(...(opts.flags ?? []))
  argv.push(...ctx.extraArgs)
  argv.push('--', ctx.prompt)
  return argv
}

async function buildAutonomousArgv(
  ctx: RunnerContext,
  opts: { model?: string; sandbox: SandboxMode; flags?: readonly string[]; fs: FsService },
): Promise<readonly string[]> {
  const argv: string[] = ['codex', 'exec', '--json', '--skip-git-repo-check', '--ephemeral']

  if (opts.sandbox === 'full-auto') {
    argv.push('--full-auto')
  } else {
    argv.push('--sandbox', opts.sandbox)
  }

  if (opts.model) {
    argv.push('-m', opts.model)
  }

  if (ctx.schema) {
    const dir = await opts.fs.tempDir('codex-schema')
    const filePath = path(`${dir}/schema.json`)
    await opts.fs.writeFile(filePath, ctx.schema.jsonSchema)
    argv.push('--output-schema', filePath)
  }

  argv.push(...(opts.flags ?? []))
  argv.push(...ctx.extraArgs)
  argv.push('--', ctx.prompt)
  return argv
}

// ---------------------------------------------------------------------------
// Auto-stop injection via a STABLE per-home CODEX_HOME (R3–R5, R7, R9)
// ---------------------------------------------------------------------------
//
// Codex stores per-hook trust in `CODEX_HOME/config.toml` under `[hooks.state]`,
// keyed by the hook's *source path*. A fresh temp `CODEX_HOME` each run gives
// every hook a brand-new path, so Codex re-shows its startup trust prompt on
// every launch. We instead reuse one stable home — `<realCodexHome>-orch` — that
// symlinks the real `~/.codex` entries (so auth/sessions are inherited) and
// carries orch's signal-only `Stop` hook. Stable paths ⇒ Codex prompts once,
// then remembers. `CODEX_HOME` is an env var, not the denylisted `-c`/`--config`.
//
// The hook lives in `hooks.json` ONLY (a single representation) — never inline
// in `config.toml` as well — so Codex never warns "loading hooks from both …".
// The user's own `hooks.json` is folded into the same file rather than symlinked,
// keeping one source of hooks while preserving their hooks.

/** Signal-only Stop hook command: pings orch's wait-for channel on turn
 *  completion. No termination, no state mutation — orch owns the pane. The
 *  socket selector is `-L <name>` (orch's server is `tmux -L orch-<runId>`);
 *  `-S <path>` would reach the wrong server. The `-S` after `wait-for` is the
 *  separate signal-channel flag. `$ORCH_*` are expanded by the hook's shell. */
const CODEX_STOP_HOOK_COMMAND = 'tmux -L "$ORCH_SOCKET" wait-for -S "$ORCH_STOP_CHANNEL"'

const CONFIG_TOML = path('config.toml')
const HOOKS_JSON = path('hooks.json')

/** Suppresses codex's "✨ Update available!" startup prompt — in auto-stop mode
 *  it steals the interactive pane and clutters the captured transcript. Bare
 *  top-level key, so it is prepended ahead of any table header to stay valid
 *  TOML. The real ~/.codex config is never touched. */
const CODEX_DISABLE_UPDATE_CHECK_LINE = 'check_for_update_on_startup = false'

/** Codex only loads `hooks.json` when the hooks feature is enabled. Appended as
 *  a fresh table when the inherited config doesn't already turn it on. */
const CODEX_ENABLE_HOOKS_BLOCK = '[features]\nhooks = true'

interface CodexHookCommand {
  readonly type: 'command'
  readonly command: string
  readonly timeout?: number
}
interface CodexHookEntry {
  readonly hooks?: readonly CodexHookCommand[]
}
interface CodexHooksFile {
  readonly hooks?: Readonly<Record<string, readonly CodexHookEntry[]>>
}

function hasUpdateCheckSetting(config: string): boolean {
  return /^\s*check_for_update_on_startup\s*=/m.test(config)
}

function hasHooksFeature(config: string): boolean {
  return /^\s*hooks\s*=\s*true/m.test(config)
}

/** Parse the real `hooks.json` (tolerating absent/malformed input as "no prior
 *  hooks") and append orch's signal-only Stop hook to the `Stop` array, unless
 *  an identical command is already declared. Rebuilt from the REAL file every
 *  run, so an updated orch command propagates and stale copies are discarded. */
function buildOrchHooksJson(realHooksJson: string): string {
  let parsed: CodexHooksFile = {}
  try {
    const candidate = JSON.parse(realHooksJson) as unknown
    if (typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)) {
      parsed = candidate as CodexHooksFile
    }
  } catch {
    // Malformed real hooks.json — start from an empty hook set so injection still
    // succeeds. (The real file is never modified.)
  }

  const priorHooks = parsed.hooks ?? {}
  const priorStop = Array.isArray(priorHooks.Stop) ? priorHooks.Stop : []
  const alreadyDeclared = priorStop.some((entry) =>
    entry.hooks?.some((h: CodexHookCommand) => h.command === CODEX_STOP_HOOK_COMMAND),
  )
  const orchEntry: CodexHookEntry = {
    hooks: [{ type: 'command', command: CODEX_STOP_HOOK_COMMAND, timeout: 30 }],
  }
  const nextStop = alreadyDeclared ? priorStop : [...priorStop, orchEntry]
  return `${JSON.stringify({ ...parsed, hooks: { ...priorHooks, Stop: nextStop } }, null, 2)}\n`
}

/** Re-sync the orch home's inherited symlinks against the real home. Idempotent:
 *  skips entries already linked so re-running across launches never throws
 *  EEXIST. `config.toml` and `hooks.json` are orch-owned (written below), not
 *  inherited, so they are excluded. */
async function syncInheritedSymlinks(fs: FsService, realHome: Path, orchHome: Path): Promise<void> {
  const entries = (await fs.exists(realHome)) ? await fs.readDir(realHome) : []
  for (const entry of entries) {
    if (entry === CONFIG_TOML || entry === HOOKS_JSON) continue
    const link = path(`${orchHome}/${entry}`)
    if (await fs.exists(link)) continue
    await fs.symlink(path(`${realHome}/${entry}`), link)
  }
}

/** Write the orch home's `config.toml` on first use only. Codex records hook
 *  trust into this file's `[hooks.state]`; rewriting it each run would wipe that
 *  and resurrect the prompt, so once it exists we leave it alone. (Delete the
 *  orch home to pick up later changes to the real config.) */
async function ensureOrchConfigToml(fs: FsService, realHome: Path, orchHome: Path): Promise<void> {
  const orchConfig = path(`${orchHome}/config.toml`)
  if (await fs.exists(orchConfig)) return

  const realConfig = path(`${realHome}/config.toml`)
  const existing = (await fs.exists(realConfig)) ? await fs.readFile(realConfig) : ''
  const header = hasUpdateCheckSetting(existing) ? '' : `${CODEX_DISABLE_UPDATE_CHECK_LINE}\n`
  const base = existing === '' || existing.endsWith('\n') ? existing : `${existing}\n`
  const features = hasHooksFeature(existing) ? '' : `\n${CODEX_ENABLE_HOOKS_BLOCK}\n`
  await fs.writeFile(orchConfig, `${header}${base}${features}`)
}

async function prepareCodexAutoStop(
  fs: FsService,
  ctx: RunnerContext,
): Promise<AutoStopPreparation> {
  // The interactive executor passes `ctx.env = {}`, so the real CODEX_HOME comes
  // from the process env (or the default) — not ctx.env. ctx.env is checked
  // first only for forward-compat with a future caller that threads it.
  const realCodexHome = path(ctx.env.CODEX_HOME ?? process.env.CODEX_HOME ?? `${homedir()}/.codex`)
  const orchCodexHome = path(`${realCodexHome}-orch`)
  await fs.mkdir(orchCodexHome, { recursive: true })

  await syncInheritedSymlinks(fs, realCodexHome, orchCodexHome)
  await ensureOrchConfigToml(fs, realCodexHome, orchCodexHome)

  // hooks.json is rebuilt from the real file every run — the single source of
  // hooks — so updates to the orch command propagate without disturbing the
  // config.toml trust state.
  const realHooks = path(`${realCodexHome}/hooks.json`)
  const realHooksJson = (await fs.exists(realHooks)) ? await fs.readFile(realHooks) : ''
  await fs.writeFile(path(`${orchCodexHome}/hooks.json`), buildOrchHooksJson(realHooksJson))

  const cleanup = async (): Promise<void> => {
    // Intentionally persistent: Codex's per-source-path hook trust lives in this
    // home's config.toml, so reusing it across runs is what makes the trust
    // prompt appear once instead of every launch. Nothing to remove.
  }
  return { env: { CODEX_HOME: orchCodexHome }, cleanup }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function codex(
  opts: CodexOptions,
  deps: { readonly fs?: FsService; readonly ps?: ProcessService } = {},
): Readonly<
  import('../types.ts').Runner & {
    buildCommand(ctx: RunnerContext): Promise<RunnerCommand>
  }
> {
  const { model, sandbox = 'full-auto', flags } = opts
  // Services are defaulted so the public `codex({...})` call form stays intact
  // (mirroring `claude({...})`); tests inject fakes. Without this, the one-arg
  // form captured `undefined` deps and buildCommand threw at first use.
  const fs = deps.fs ?? new BunFsService()
  const ps = deps.ps ?? new BunProcessService()

  let versionChecked = false
  let lastAgentMessage: string | undefined

  return defineRunner({
    name: 'codex',
    supports: { interactive: true, structuredOutput: true },
    defaultView: { kind: 'transcript', pane: 'right' },

    async buildCommand(ctx: RunnerContext): Promise<RunnerCommand> {
      lastAgentMessage = undefined // Reset per invocation, regardless of mode

      for (const flag of flags ?? []) assertFlagAllowed(flag)
      for (const flag of ctx.extraArgs) assertFlagAllowed(flag)

      if (ctx.mode === 'interactive' && ctx.schema) {
        throw new Error(
          'codex(): schema-typed steps cannot run in interactive mode — ' +
            '--output-schema is exec-only, and schema-shaped output has no ' +
            'meaning in the interactive TUI',
        )
      }

      if (!versionChecked) {
        await checkCodexVersion(ps)
        versionChecked = true
      }

      if (ctx.mode === 'interactive') {
        return {
          argv: buildInteractiveArgv(ctx, { model, sandbox, flags }),
          // FORCE_COLOR=3 mirrors Claude's interactive path — harmless for
          // Ratatui (Codex's TUI does its own TTY/COLORTERM detection) and
          // useful when the inherited stdio path strips color hints. ctx.env
          // wins last so workflow authors can disable it.
          env: mergeEnv(process.env, { FORCE_COLOR: '3' }, ctx.env),
        }
      }

      const argv = await buildAutonomousArgv(ctx, { model, sandbox, flags, fs })
      // Env: passthrough by default (see mergeEnv contract). Codex has no
      // mode-specific extras today, so the middle layer is `{}`. `ctx.env`
      // wins last on conflict — the workflow YAML is the override surface.
      return { argv, env: mergeEnv(process.env, {}, ctx.env) }
    },

    parseEvents(line: string): RunnerEvent | null {
      const evt = parseCodexLine(line)

      // Accumulate agent_message text for structured output extraction
      if (evt !== null && evt.kind === 'info' && evt.type === 'item.completed') {
        const item = (evt.payload as Record<string, unknown> | undefined)?.item
        if (typeof item === 'object' && item !== null) {
          const typedItem = item as Record<string, unknown>
          if (typedItem.type === 'agent_message' && typeof typedItem.text === 'string') {
            lastAgentMessage = typedItem.text
          }
        }
      }

      // Stash accumulated text into terminal event data
      if (evt !== null && evt.kind === 'terminal' && evt.type === 'turn-complete') {
        return {
          kind: 'terminal',
          type: 'turn-complete',
          data: { ...(evt.data as Record<string, unknown>), _accumulatedText: lastAgentMessage },
        }
      }

      return evt
    },

    extractStructuredOutput(finalEvent: TerminalEvent): unknown {
      if (finalEvent.type === 'error') return undefined

      const data = finalEvent.data as Record<string, unknown> | undefined
      const text = data?._accumulatedText
      if (typeof text !== 'string') return undefined
      try {
        return JSON.parse(text) as unknown
      } catch {
        return text
      }
    },

    toTranscriptLines: toCodexTranscriptLines,

    resumeCommand(ctx: RunnerContext, sessionId: string): RunnerCommand {
      // Codex resume is its own subcommand. The current sandbox/model flags
      // don't apply to `codex resume` (it inherits the original thread's
      // configuration); we only thread through caller-supplied extras.
      // `--no-alt-screen` is a top-level flag and must precede the sessionId
      // positional, mirroring the interactive default so resumed sessions
      // get the same flat-buffer behavior the smart-wheel binding expects.
      const argv = [
        'codex',
        'resume',
        '--no-alt-screen',
        sessionId,
        ...(flags ?? []),
        ...ctx.extraArgs,
      ]
      return { argv, env: mergeEnv(process.env, { FORCE_COLOR: '3' }, ctx.env) }
    },

    // Codex mints its own `thread_id` only after writing the first line of a
    // rollout — there's no pre-set flag. We acquire the per-workflow capture
    // lock first (so two concurrent Codex captures serialize), then snapshot
    // `~/.codex/sessions/YYYY/MM/DD/` and poll for the new file. The lock
    // releases as soon as the capture window completes (success, error, or
    // timeout) so the interactive session itself is never blocked behind it.
    captureSessionId(ctx: CaptureSessionIdContext): CaptureHandle {
      return runCaptureSessionId(ctx)
    },

    prepareAutoStop(ctx: RunnerContext): Promise<AutoStopPreparation> {
      return prepareCodexAutoStop(fs, ctx)
    },
  })
}

function runCaptureSessionId(ctx: CaptureSessionIdContext): CaptureHandle {
  let resolveSnap: () => void = () => {}
  let resolveResult: (value: CaptureResult) => void = () => {}
  const snapshotReady = new Promise<void>((res) => {
    resolveSnap = res
  })
  const result = new Promise<CaptureResult>((res) => {
    resolveResult = res
  })

  void (async (): Promise<void> => {
    let release: () => void = () => {}
    try {
      release = await ctx.lock.acquire()
      const sessionsRoot = resolveCodexSessionsRoot({
        envOverride: process.env.ORCH_CODEX_SESSIONS_ROOT,
        homedir: homedir(),
      })
      const handle = captureCodexThreadId({
        fs: ctx.fs,
        clock: ctx.clock,
        cwd: ctx.cwd,
        sessionsRoot,
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
      })
      // Forward snapshotReady regardless of how the inner result settles so
      // the workflow's `await snapshotReady` can never hang on a runner-side
      // failure mode that resolves the result without resolving snapshot.
      handle.snapshotReady.then(resolveSnap, resolveSnap)
      const outcome = await handle.result
      resolveResult(outcome)
    } catch {
      // Defensive: the helper is supposed to fold all errors into
      // { error: 'error' }, but if the lock acquire or resolution path
      // itself throws we still need to settle both promises.
      resolveSnap()
      resolveResult({ error: 'error' })
    } finally {
      release()
    }
  })()

  return { snapshotReady, result }
}
