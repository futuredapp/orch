// ---------------------------------------------------------------------------
// Host — the observability seam the workflow executor talks to.
// ---------------------------------------------------------------------------
//
// Phase A introduces the port; only `plain` implements it end-to-end. Phase D
// wires `two-pane`. `single-pane` is reserved for v2.
//
// The executor no longer carries `onEvent` / `onStepEvent` callbacks — every
// observability signal travels through `host.onRunnerEvent` /
// `host.onLifecycleEvent`, and interactive steps attach their view through
// `host.attach(...)`. Replacing two parallel callback hooks with one seam
// keeps test mocks honest (one mockable port vs. two) and makes hosts
// swappable at a single place in the composition root.
//
// Phase A's `PlainHost` is a transparent line-prefixer: lifecycle events land
// as `[orch] …` lines, runner events as `[<step>] …` lines, and `--format=json`
// emits NDJSON on stdout instead. Pane hints are ignored under plain — the
// stdout stream is a single sink regardless of which pane a view claims.

import type { RunMode } from '../core/run-mode.ts'
import type { Path, StepName } from '../core/types.ts'
import type { PaneRole } from '../core/view.ts'
import type { StepLifecycleEvent } from '../core/workflow.ts'
import type { RunnerEvent, TranscriptLine } from '../runners/index.ts'

// v1 panes. `left` == status rollup, `right` == active step's view. The
// canonical definition lives in core/view.ts so workflow and hosts can agree
// without circular imports; re-exported here for back-compat with existing
// Host-consumer imports from `src/hosts/index.ts`.
export type { PaneRole }

/**
 * Handle returned from `host.attach(...)`. Hosts that physically own a pane
 * (tmux) use `detach()` to hand the pane back; plain host's detach is a no-op.
 * Intentionally keeps both the RAII-style method AND `AsyncDisposable` so
 * callers can pick either style — keeps Phase D's `respawn-pane -k` flow
 * simple without breaking the Phase A contract.
 */
export interface PaneAttachment {
  readonly pane: PaneRole
  detach(): Promise<void>
}

/**
 * Arguments for running an interactive process on the host. The plain host
 * maps this to `spawnForeground`; the tmux host maps it to `respawn-pane -k`
 * on the targeted pane and then waits on `wait-for pane-exit-<paneId>`.
 */
export interface InteractiveSpawn {
  readonly argv: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly cwd: Path
  /** Step name — used by hosts for logging / pane hints. */
  readonly stepName: StepName
  /**
   * Which pane (under tmux) the spawn targets. Defaults to `'right'`.
   *
   * - `'right'` (default): tmux-host respawns the right pane, waits for the
   *   child's exit, then respawns `cat` back so the next transcript stream
   *   has a clean placeholder. This is the interactive-step path.
   * - `'left'`: tmux-host respawns the left pane and SKIPS the `cat` restore
   *   on exit — the left pane is the steps-view daemon's home; on
   *   unexpected exit the caller takes over the pane via `PaneQueue`.
   *
   * Plain host ignores this field; the foreground spawn is the same
   * regardless of pane.
   */
  readonly pane?: PaneRole
}

export interface InteractiveResult {
  readonly exitCode: number
  readonly durationMs: number
}

/**
 * One framed line of stdout or stderr from a `command()` step. Hosts deliver
 * these to the right (or `pane`-overridden) pane; plain host prints prefixed
 * lines to the matching stdio stream. Distinct from `RunnerEvent` because
 * commands emit unstructured text — the runtime invariant "every onRunnerEvent
 * has a real Runner upstream" stays true.
 */
export interface CommandLine {
  readonly stream: 'stdout' | 'stderr'
  readonly line: string
  readonly step: StepName
  readonly pane: PaneRole
}

/**
 * Discriminator returned by `Host.awaitForegroundShutdown()`. `'quit'` means
 * the user asked orch to stop (q / Ctrl-C / future cancel surfaces);
 * `'attach-exited'` means the foreground attach client went away without an
 * explicit quit intent (user detached, session died, plain mode no-op).
 */
export type ForegroundShutdownReason = 'quit' | 'attach-exited'

export interface Host {
  readonly mode: RunMode
  /** First-run banner; emitted once per invocation by the CLI entry point. */
  writeBanner(line: string): void
  /**
   * Called by the workflow executor for every autonomous-step RunnerEvent.
   * `lines` is the runner-formatted transcript output the host renders for
   * `format=text` paths; `event` stays in the signature so JSON paths can
   * write the raw envelope without re-serialising. Always non-undefined —
   * may be empty (suppression) or contain multiple lines per event.
   */
  onRunnerEvent(event: RunnerEvent, step: StepName, lines: readonly TranscriptLine[]): void
  /** Called by the workflow executor for every StepLifecycleEvent. */
  onLifecycleEvent(event: StepLifecycleEvent): void
  /**
   * Called by the workflow executor for every line of stdout/stderr produced
   * by a `command()` step. Plain host prints `[<step>] <line>` to the matching
   * stdio stream (or NDJSON under `format=json`); two-pane host enqueues the
   * line on the resolved pane via the per-pane queue, preserving ANSI bytes.
   */
  onCommandLine(spec: CommandLine): void
  /**
   * Attach a view on a given pane. Phase A only uses this for interactive
   * steps (to signal the host that a step owns the screen); plain ignores
   * the pane and returns a no-op handle. Phase D uses it to respawn tmux
   * panes when interactive steps begin.
   */
  attach(pane: PaneRole): Promise<PaneAttachment>
  /**
   * Run an interactive process on the host's own terms.
   *
   * - Plain host spawns in the foreground (inherited stdio); exit code flows
   *   back when the process ends.
   * - Tmux host respawns the right pane with the runner argv, then waits for
   *   `pane-exit-<paneId>`; on exit, the pane is respawned back to `cat` so
   *   the next transcript stream has a clean placeholder.
   */
  runInteractive(opts: InteractiveSpawn): Promise<InteractiveResult>
  /**
   * Hand the controlling TTY to the host for the duration of the run.
   *
   * - Two-pane host: spawns `tmux attach-session` with inherited stdio.
   *   Resolves when the attach client exits — either because the user
   *   detached (`Ctrl-b d`), or because `teardown()` killed the session.
   * - Plain host: resolves immediately (no-op — plain never takes the TTY).
   *
   * The CLI races this against the workflow promise; whichever settles
   * first drives shutdown. See the two-pane auto-attach plan for the full
   * state diagram.
   */
  attachForeground(): Promise<void>
  /**
   * Wait for the foreground shutdown signal and report which branch settled
   * first:
   *
   * - `'quit'`     — the user explicitly quit the foreground UI (two-pane:
   *                  `q` intent or Ctrl-C captured by the steps-view daemon).
   *                  The CLI MUST tear orch down — the workflow does not get
   *                  a chance to finish.
   * - `'attach-exited'` — `attachForeground()` resolved on its own (two-pane:
   *                  user detached, or the tmux session died externally;
   *                  plain: immediate). The CLI keeps the workflow running
   *                  and prints the "re-attach with…" hint.
   *
   * Plain mode resolves immediately with `'attach-exited'` — there's no
   * foreground UI to wait on, and there is no quit-intent vector.
   *
   * Phase 4: replaces the previous "workflow promise drives the race"
   * contract so the steps-view daemon can keep the TUI mounted past
   * workflow completion (showing the end-of-run summary) until the user
   * presses `q`. The tagged return discriminates a user-quit from a benign
   * detach — same signal, very different shutdown semantics in the CLI.
   */
  awaitForegroundShutdown(): Promise<ForegroundShutdownReason>
  /**
   * Cheap probe: is the host's backing surface still alive?
   *
   * Used by the launcher right after `attachForeground()` resolves with the
   * `'attach-exited'` reason: a clean user-detach (prefix-d) leaves the
   * tmux server alive, so the workflow can keep running in the background;
   * a tmux server death also makes the attach client exit, but the next
   * interactive step has nowhere to spawn. We need to tell those two apart
   * BEFORE printing the "run continues in background" hint, which would
   * otherwise mislead the user (see incident r-2026-05-22-093650-j0).
   *
   * - Plain host: always `reachable: true` (no backing surface to lose).
   * - Two-pane host: probes the tmux server and both sessions.
   */
  probeReachability(): Promise<HostReachability>
  teardown(): Promise<void>
}

/**
 * Result of `Host.probeReachability()`. When `reachable === false`, the
 * `reason` field carries a short human-readable string the CLI can quote in
 * the failure summary ("tmux server is no longer reachable").
 */
export interface HostReachability {
  readonly reachable: boolean
  readonly reason?: string
}

/**
 * Thrown from `createTmuxHost` when the environment can't host an auto-attach
 * session (e.g. nested tmux). CLI maps to CONFIG_ERROR exit and prints the
 * error message with the user-facing escape options.
 */
export class HostCreationError extends Error {
  readonly code = 'HOST_CREATION_ERROR' as const
  constructor(message: string) {
    super(message)
    this.name = 'HostCreationError'
  }
}

/**
 * Thrown from `Host.runInteractive` when the host can no longer satisfy the
 * spawn request because its backing surface has gone away mid-run — e.g. the
 * tmux server died externally (`[server exited]`) after the user detached,
 * and the next interactive step cannot allocate a pane on the dead socket.
 *
 * Distinct from `HostCreationError` (which fires at construction) and from
 * `StepError` (which means the step ran and returned a bad exit code).
 * `mapRunError` translates this into a clean failure summary instead of
 * letting a raw `TmuxCommandError` escape `executeWithAttach` as an
 * unhandled rejection.
 */
export class HostUnavailableError extends Error {
  readonly code = 'HOST_UNAVAILABLE' as const
  override readonly cause: unknown
  constructor(message: string, cause: unknown) {
    super(message)
    this.name = 'HostUnavailableError'
    this.cause = cause
    Object.setPrototypeOf(this, new.target.prototype)
  }
}
