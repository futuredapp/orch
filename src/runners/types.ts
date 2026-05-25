import { z } from 'zod'
import type { ViewDefault } from '../core/view.ts'
import type { Clock } from '../services/clock/index.ts'
import type { FsService } from '../services/fs/index.ts'
import type { Path } from '../services/types.ts'

// ---------------------------------------------------------------------------
// RunnerContext — the input bag every runner receives
// ---------------------------------------------------------------------------

export interface RunnerContext {
  readonly cwd: Path
  readonly env: Readonly<Record<string, string>>
  readonly prompt: string
  readonly extraArgs: readonly string[]
  readonly schema?: { readonly jsonSchema: string }
  readonly mode?: 'interactive' | 'autonomous'
  /** Session ID for interactive steps. Passed via --session-id. */
  readonly sessionId?: string
  /**
   * Set when the interactive step opted into auto-stop (`autoStop: true`).
   * Runners that implement `prepareAutoStop` read this only as a signal that
   * the executor will call `prepareAutoStop`; the preparation itself needs no
   * values from the context beyond `cwd`/`env`. Absent on autonomous steps.
   */
  readonly autoStop?: boolean
}

// ---------------------------------------------------------------------------
// AutoStopPreparation — return type of the optional prepareAutoStop capability
// ---------------------------------------------------------------------------

/**
 * What `Runner.prepareAutoStop` hands back to the executor. `env` carries any
 * runner-injected environment additions (e.g. Codex's `CODEX_HOME`) that ride
 * the `extras` slot of `mergeEnv`; it is `{}` when the runner writes a cwd file
 * the CLI discovers on its own (Claude). `cleanup` is an idempotent inverse the
 * host runs in its `finally` regardless of how the step ends; it must only
 * touch per-run artifacts and never the user's real config or credentials.
 */
export interface AutoStopPreparation {
  readonly env: Readonly<Record<string, string>>
  readonly cleanup: () => Promise<void>
}

// ---------------------------------------------------------------------------
// Events — two-level discriminated union (kind + type)
//
// Without `kind`, TS structural subtyping collapses RunnerEvent to InfoEvent
// because InfoEvent.type is `string` which subsumes TerminalEvent.type literals.
// Verified empirically with tsc 6.0.2 --strict --noUncheckedIndexedAccess.
// ---------------------------------------------------------------------------

export type TerminalEvent =
  | { readonly kind: 'terminal'; readonly type: 'turn-complete'; readonly data?: unknown }
  | {
      readonly kind: 'terminal'
      readonly type: 'error'
      readonly message: string
      readonly data?: unknown
    }

export interface InfoEvent {
  readonly kind: 'info'
  readonly type: string
  readonly payload?: Readonly<Record<string, unknown>>
}

export type RunnerEvent = TerminalEvent | InfoEvent

export function isTerminalEvent(e: RunnerEvent): e is TerminalEvent {
  return e.kind === 'terminal'
}

// ---------------------------------------------------------------------------
// TranscriptLine — runner-formatted, host-rendered.
//
// Runners pre-format every RunnerEvent into zero-or-more TranscriptLines.
// Hosts map `category` to glyph/color (presentation policy) and add the
// `[<step>] ` prefix; runners stay free of ANSI and pane-width concerns.
// `kind: 'block'` carries multi-line completion/failure summaries.
// ---------------------------------------------------------------------------

export type TranscriptCategory =
  | 'system'
  | 'thinking'
  | 'tool-call'
  | 'tool-result'
  | 'tool-error'
  | 'assistant'

export type TranscriptLine =
  | {
      readonly kind: 'line'
      readonly category: TranscriptCategory
      readonly label?: string
      readonly body: string
    }
  | {
      readonly kind: 'block'
      readonly heading: 'done' | 'failed'
      readonly rows: ReadonlyArray<readonly [label: string, value: string]>
    }

// ---------------------------------------------------------------------------
// RunnerCommand — return type of buildCommand
// ---------------------------------------------------------------------------

export interface RunnerCommand {
  readonly argv: readonly string[]
  /** Full replacement — passed directly to ProcessService. No automatic merge with process.env. */
  readonly env: Readonly<Record<string, string>>
}

// ---------------------------------------------------------------------------
// Runner — the port every CLI adapter implements
// ---------------------------------------------------------------------------

export interface Runner {
  readonly name: string
  readonly supports: { readonly interactive: boolean; readonly structuredOutput: boolean }
  /**
   * What view + pane this runner declares for autonomous steps by default.
   * Optional so third-party runners written against the Phase 1 interface
   * stay source-compatible; the layered resolver in core falls back to
   * `{ kind: 'transcript', pane: 'right' }` when absent.
   */
  readonly defaultView?: ViewDefault
  /**
   * Build the CLI argv + env for this runner. May return a Promise when the
   * adapter needs async preparation (e.g. writing a temp schema file).
   * Consumers must always `await` the result.
   */
  buildCommand(ctx: RunnerContext): RunnerCommand | Promise<RunnerCommand>
  parseEvents(line: string): RunnerEvent | null
  extractStructuredOutput(finalEvent: TerminalEvent): unknown
  /**
   * Format a `RunnerEvent` for the human-readable transcript stream.
   * Return `[]` to suppress the event entirely (e.g. `rate_limit_event`).
   *
   * Pure: no I/O, no external state. Called synchronously by the executor
   * before the event reaches the host. A throw is caught by the executor and
   * logged once; the event is still persisted to disk via the JSON path.
   */
  toTranscriptLines(event: RunnerEvent): readonly TranscriptLine[]
  /**
   * Build the argv + env that resumes a previously captured session.
   * Optional — runners that lack a resume primitive omit it; the right-pane
   * controller refuses with a footer message at the call site.
   *
   * Capability check: `typeof runner.resumeCommand === 'function'`. There is
   * NO `supports.resume` flag — the optional method is the single source of
   * truth.
   */
  resumeCommand?(ctx: RunnerContext, sessionId: string): RunnerCommand | Promise<RunnerCommand>
  /**
   * Capture the underlying CLI's own session identifier for use with `resumeCommand`.
   * Optional — runners whose CLI accepts a pre-set session id (e.g. Claude's
   * `--session-id`) leave this `undefined` and rely on the workflow-generated
   * UUID. Runners that mint their own id post-spawn (Codex's `thread_id`) implement
   * this method.
   *
   * Two-phase return: `snapshotReady` resolves once the helper has taken its
   * initial baseline of the relevant filesystem state. Callers MUST await
   * `snapshotReady` before spawning the CLI so the new rollout file lands
   * outside the baseline. `result` resolves with either the captured
   * `sessionId` or a typed error.
   *
   * Capability check: `typeof runner.captureSessionId === 'function'`.
   */
  captureSessionId?(ctx: CaptureSessionIdContext): CaptureHandle
  /**
   * Prepare a per-run, signal-only stop hook so the agent CLI pings orch over
   * a tmux `wait-for` channel when it finishes a turn. The runner writes its
   * CLI-specific artifact (Claude: a merge-safe `.claude/settings.local.json`
   * in cwd; Codex: a temp `CODEX_HOME` with a `notify` line), referencing the
   * env-var NAMES `$ORCH_SOCKET` / `$ORCH_STOP_CHANNEL` that the tmux host
   * injects at spawn. Returns `{ env, cleanup }` — `env` for any runner-side
   * additions, `cleanup` an idempotent inverse the host runs in `finally`.
   *
   * Optional — runners that cannot register a stop hook omit it. The executor
   * fails fast with `AutoStopUnsupportedError` when a step sets `autoStop: true`
   * against a runner lacking this method.
   *
   * Capability check: `typeof runner.prepareAutoStop === 'function'`. There is
   * NO `supports.autoStop` flag — the optional method is the single source of
   * truth, mirroring `resumeCommand` / `captureSessionId`.
   */
  prepareAutoStop?(ctx: RunnerContext): Promise<AutoStopPreparation>
}

// ---------------------------------------------------------------------------
// captureSessionId — post-spawn session-id capture (Codex's thread_id today)
// ---------------------------------------------------------------------------

/** Result discriminant for capture failure. Mirrored verbatim in the
 *  `StepEntry.sessionIdCaptureError` Zod enum. */
export type CaptureError = 'ambiguous' | 'empty' | 'error'

export type CaptureResult = { readonly sessionId: string } | { readonly error: CaptureError }

/** Per-workflow mutex used to serialize concurrent capture windows that share
 *  the same backing filesystem. See `src/runners/codex/capture-lock.ts`. */
export interface CaptureLock {
  acquire(): Promise<() => void>
}

export interface CaptureSessionIdContext {
  readonly cwd: Path
  readonly fs: FsService
  readonly clock: Clock
  readonly lock: CaptureLock
  readonly signal?: AbortSignal
  /** Total capture window. Adapter chooses a sensible default when omitted. */
  readonly timeoutMs?: number
}

export interface CaptureHandle {
  readonly snapshotReady: Promise<void>
  readonly result: Promise<CaptureResult>
}

// ---------------------------------------------------------------------------
// defineRunner — validating identity factory
//
// Uses safeParse to avoid leaking config values in error messages (S7).
// Returns the original config frozen — not Zod's inferred output — to
// preserve the caller's literal type T.
// ---------------------------------------------------------------------------

const RunnerAdapterSchema = z.object({
  name: z.string().min(1),
  supports: z.object({
    interactive: z.boolean(),
    structuredOutput: z.boolean(),
  }),
  // View kind stays a bare string at the schema layer so v2 plugins that widen
  // `ViewKindRegistry` via interface augmentation can ship custom kinds
  // without editing core; pane is locked to the two v1 slots.
  defaultView: z
    .object({
      kind: z.string().min(1),
      pane: z.enum(['left', 'right']),
    })
    .optional(),
  buildCommand: z.custom<Runner['buildCommand']>((v) => typeof v === 'function', {
    message: 'expected function',
  }),
  parseEvents: z.custom<Runner['parseEvents']>((v) => typeof v === 'function', {
    message: 'expected function',
  }),
  extractStructuredOutput: z.custom<Runner['extractStructuredOutput']>(
    (v) => typeof v === 'function',
    { message: 'expected function' },
  ),
  toTranscriptLines: z.custom<Runner['toTranscriptLines']>((v) => typeof v === 'function', {
    message: 'expected function',
  }),
  // Optional resume primitive. Without this slot, defineRunner(...) rejects
  // any runner that declares resumeCommand at validation time.
  resumeCommand: z
    .custom<NonNullable<Runner['resumeCommand']>>((v) => typeof v === 'function', {
      message: 'expected function',
    })
    .optional(),
  // Optional capture primitive. Parallels `resumeCommand`: runners that mint
  // their session id post-spawn declare it; runners that pre-set the id leave
  // it `undefined`. The workflow executor's capability check at the call site
  // (`typeof config.agent.captureSessionId === 'function'`) is the single
  // source of truth.
  captureSessionId: z
    .custom<NonNullable<Runner['captureSessionId']>>((v) => typeof v === 'function', {
      message: 'expected function',
    })
    .optional(),
  // Optional auto-stop primitive. Parallels `resumeCommand` / `captureSessionId`:
  // runners that can register a signal-only stop hook declare it; the rest leave
  // it `undefined`. The executor's capability check
  // (`typeof config.agent.prepareAutoStop === 'function'`) is the single source
  // of truth and powers the fail-fast `AutoStopUnsupportedError`.
  prepareAutoStop: z
    .custom<NonNullable<Runner['prepareAutoStop']>>((v) => typeof v === 'function', {
      message: 'expected function',
    })
    .optional(),
})

export function defineRunner<T extends Runner>(config: T): Readonly<T> {
  const result = RunnerAdapterSchema.safeParse(config)
  if (!result.success) {
    const fields = result.error.issues.map((i) => i.path.join('.')).join(', ')
    throw new Error(`defineRunner: invalid runner config (fields: ${fields})`)
  }
  return Object.freeze(config)
}
