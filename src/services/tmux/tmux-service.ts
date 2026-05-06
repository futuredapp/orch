// ---------------------------------------------------------------------------
// TmuxService — port for all tmux interactions
// ---------------------------------------------------------------------------
//
// All tmux logic lives behind this interface. Adapters must shell out via
// `ProcessService` with array-based argv — never shell strings — to prevent
// command injection. Socket names are branded so that any `-L` substitution
// is statically proven safe.

import type { Path } from '../types.ts'

// ---------------------------------------------------------------------------
// Branded types
// ---------------------------------------------------------------------------

/** A tmux pane id produced by `split-window -P -F '#{pane_id}'` (e.g. `%42`). */
export type PaneId = string & { readonly __brand: 'PaneId' }

/**
 * A tmux server socket name (tmux `-L`). Restricted to `[a-z0-9-]+` so that
 * interpolation into `run-shell` templates cannot inject metacharacters.
 */
export type SocketName = string & { readonly __brand: 'SocketName' }

const PANE_ID_PATTERN = /^%\d+$/
const SOCKET_NAME_PATTERN = /^[a-z0-9-]+$/

/** Smart constructor for `PaneId`. Accepts only `%\d+`. */
export const paneId = (s: string): PaneId => {
  if (!PANE_ID_PATTERN.test(s)) {
    throw new Error(`paneId(): invalid pane id ${JSON.stringify(s)} (expected /^%\\d+$/)`)
  }
  return s as PaneId
}

/** Smart constructor for `SocketName`. Accepts only `[a-z0-9-]+`. */
export const socketName = (s: string): SocketName => {
  if (!SOCKET_NAME_PATTERN.test(s)) {
    throw new Error(`socketName(): invalid socket ${JSON.stringify(s)} (expected /^[a-z0-9-]+$/)`)
  }
  return s as SocketName
}

// ---------------------------------------------------------------------------
// TmuxCommandError — thrown by adapters on non-zero tmux exit
// ---------------------------------------------------------------------------
//
// Follows the `GitCommandError` shape so consumers can render structured
// failure context without parsing generic `Error` messages.

export class TmuxCommandError extends Error {
  readonly exitCode: number
  readonly stderr: string

  constructor(exitCode: number, stderr: string, message: string) {
    super(message)
    this.name = 'TmuxCommandError'
    this.exitCode = exitCode
    this.stderr = stderr
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface CreateSessionOptions {
  readonly socket: SocketName
  /** Session name inside the server. */
  readonly session: string
  /** Terminal width in columns (forwarded to `-x`). */
  readonly width: number
  /** Terminal height in rows (forwarded to `-y`). */
  readonly height: number
  /**
   * Path to a tmux config file passed as `-f <path>`. Load-bearing for
   * `history-limit 0`: tmux captures `history-limit` at pane allocation
   * (tmux/tmux#4705), so a `set -g history-limit 0` issued *after*
   * `new-session` does NOT shrink the initial pane's already-allocated
   * grid. The `-f` path is read before any pane exists. When omitted, the
   * adapter passes `-f /dev/null` (the appliance default that ignores the
   * user's `~/.tmux.conf`).
   */
  readonly configPath?: Path
}

export interface SplitPaneOptions {
  readonly socket: SocketName
  readonly session: string
  /**
   * Orientation of the split. `h` = horizontal (left/right), `v` = vertical.
   */
  readonly orientation: 'h' | 'v'
  /** Percentage of the parent pane the new split should occupy (1–99). */
  readonly percent: number
  /** Optional shell command to run in the new pane. Defaults to `cat`. */
  readonly command?: string
}

export interface SendKeysOptions {
  readonly socket: SocketName
  readonly target: PaneId
  /**
   * Literal keystrokes. Each entry is passed as one positional argument after
   * `-l` so tmux treats it verbatim (no key-name interpretation).
   */
  readonly keys: readonly string[]
  /** Append `Enter` after the keys (send-keys `Enter`). */
  readonly enter?: boolean
}

export interface WaitForOptions {
  readonly socket: SocketName
  readonly channel: string
  /**
   * Maximum wall-clock milliseconds to wait before throwing. Omit to wait
   * indefinitely — interactive steps use this so the user can pause the
   * agent for arbitrarily long without orch killing the run.
   */
  readonly timeoutMs?: number
}

export interface SignalChannelOptions {
  readonly socket: SocketName
  readonly channel: string
}

export interface SetOptionOptions {
  readonly socket: SocketName
  readonly target: PaneId | string
  readonly name: string
  readonly value: string
  /** `-g` for global, default per-target. */
  readonly global?: boolean
}

export interface SetHookOptions {
  readonly socket: SocketName
  readonly hook: string
  readonly command: string
  /** Always `true` in phase 13b — per-pane hooks have known bugs. */
  readonly global: true
}

export interface DisplayMessageOptions {
  readonly socket: SocketName
  readonly target: PaneId
  /** A tmux format string (e.g. `#{pane_dead}`). */
  readonly format: string
}

export interface KillPaneOptions {
  readonly socket: SocketName
  readonly target: PaneId
}

export interface KillSessionOptions {
  readonly socket: SocketName
  readonly session: string
}

export interface AttachSessionOptions {
  readonly socket: SocketName
  readonly session: string
}

export interface SelectPaneOptions {
  readonly socket: SocketName
  readonly target: PaneId
}

export interface CapturePaneOptions {
  readonly socket: SocketName
  readonly target: PaneId
  /** Include escape sequences in the output (`-e`). Defaults to `false`. */
  readonly escapeCodes?: boolean
  /** Join wrapped lines (`-J`). Defaults to `false`. */
  readonly joinWrapped?: boolean
}

export interface PipePaneOptions {
  readonly socket: SocketName
  readonly target: PaneId
  /**
   * Shell command tmux pipes stdout into. Kept intentionally opaque — observe
   * mode hands raw bytes to a user-supplied sink (e.g. `cat >> file.log`).
   * Callers MUST compose this with a hardcoded template; tmux runs it through
   * `/bin/sh -c`.
   */
  readonly command: string
  /** `pipe-pane -O` appends to an existing pipe instead of replacing it. */
  readonly append?: boolean
}

export interface ListPanesOptions {
  readonly socket: SocketName
  readonly session: string
  /** Format string passed via `-F` (e.g. `#{pane_id}`). */
  readonly format: string
}

export interface RespawnPaneOptions {
  readonly socket: SocketName
  readonly target: PaneId
  /**
   * Argv for the replacement process. Array-only, never a shell string — tmux
   * passes each element verbatim as argv, so step names containing `;`, `$()`,
   * `\n`, or backticks cannot inject. The array shape is load-bearing for Phase
   * D's `respawn-pane -k` interactive handoff.
   */
  readonly argv: readonly string[]
  /** `-k` — terminate any running process in the target pane before respawning. */
  readonly killRunning: boolean
  /**
   * Optional per-pane environment overrides. Each entry becomes a tmux
   * `-e KEY=VAL` flag on the `respawn-pane` argv before the `--` separator,
   * so the replacement process inherits the tmux server's env extended (and
   * overridden) by these entries. Adapters MUST reject keys containing `=`
   * or newline — they corrupt the `-e KEY=VAL` argv shape.
   */
  readonly env?: Readonly<Record<string, string>>
  /**
   * Optional `-c <cwd>` flag — sets the pane's working directory at respawn
   * time. Without it, tmux keeps the pane's existing cwd (which is the cwd
   * of the tmux client that created the pane: `/` for orch's
   * RealTmuxService). Required for runner respawns so the agent sees the
   * project cwd; `cat` placeholder restores omit it (cat needs no cwd).
   */
  readonly cwd?: Path
}

// ---------------------------------------------------------------------------
// Key-binding tables (PR A — strict tmux sandbox)
// ---------------------------------------------------------------------------
//
// Tmux groups bindings into "key tables". `root` (mouse + key events without a
// prefix), `prefix` (events after the prefix key), `copy-mode`, and
// `copy-mode-vi` are the four namespaces that can fire `send-keys -X` against
// the running pane — the source of every "not in a mode" leak the appliance
// fix wipes out. `bind-key -n <key>` is shorthand for "bind in `root` without
// the prefix"; we expose it as a virtual `'root-no-prefix'` table so callers
// don't have to thread `-n` through a separate flag.

/** A tmux key-table name accepted by `unbind-key`. */
export type KeyTable = 'root' | 'prefix' | 'copy-mode' | 'copy-mode-vi'

/**
 * A tmux key-table accepted by `bind-key`. `'root-no-prefix'` emits
 * `bind-key -n` (root with no prefix); all other values emit
 * `bind-key -T <table>`.
 */
export type BindTable = KeyTable | 'root-no-prefix'

export interface UnbindKeyOptions {
  readonly socket: SocketName
  readonly table: KeyTable
}

export interface BindKeyOptions {
  readonly socket: SocketName
  readonly table: BindTable
  /**
   * Tmux key sequence (e.g. `MouseDrag1Border`, `M-Left`). Adapter rejects
   * `\n` / `\0`.
   */
  readonly key: string
  /**
   * Raw argv passed verbatim to tmux. Hardcoded constants only — no user
   * input ever reaches this seam (the single caller, `initOrchSession`,
   * iterates over a frozen `ALLOWLIST`). Tmux does not re-parse argv; it
   * interprets command-language metacharacters (`;`, `${}`, `#{}`, quotes,
   * backslash) only inside *strings*, which never reach this path.
   */
  readonly command: readonly string[]
}

// ---------------------------------------------------------------------------
// TmuxService
// ---------------------------------------------------------------------------

export interface TmuxService {
  /** `tmux -L <socket> new-session -d -s <session> -x <w> -y <h> -f /dev/null`. */
  createSession(opts: CreateSessionOptions): Promise<void>

  /**
   * `tmux -L <socket> split-window -P -F '#{pane_id}' ...` — returns the new
   * pane id parsed from stdout.
   */
  splitPane(opts: SplitPaneOptions): Promise<PaneId>

  /** `tmux -L <socket> send-keys -t <pane> -l <keys...>` (+ optional Enter). */
  sendKeys(opts: SendKeysOptions): Promise<void>

  /**
   * `tmux -L <socket> wait-for <channel>`. When `timeoutMs` is set, raced
   * against a timer and throws `TmuxCommandError` on timeout. When omitted,
   * waits indefinitely until the channel is signalled.
   */
  waitFor(opts: WaitForOptions): Promise<void>

  /** `tmux -L <socket> wait-for -S <channel>` — unblocks a pending `waitFor`. */
  signalChannel(opts: SignalChannelOptions): Promise<void>

  /** `tmux -L <socket> set-option [-g] -t <target> <name> <value>`. */
  setOption(opts: SetOptionOptions): Promise<void>

  /** `tmux -L <socket> set-hook -g <hook> <command>` (global hooks only). */
  setHook(opts: SetHookOptions): Promise<void>

  /**
   * `tmux -L <socket> display-message -p -t <target> <format>` — returns the
   * rendered format text. Adapters MUST reject empty output as "invalid
   * pane": tmux returns exit 0 with empty stdout when the pane is gone.
   */
  displayMessage(opts: DisplayMessageOptions): Promise<string>

  /** `tmux -L <socket> kill-pane -t <pane>`. */
  killPane(opts: KillPaneOptions): Promise<void>

  /**
   * `tmux -L <socket> kill-session -t <session>`. Tears down the named
   * session and its panes. Adapters MUST tolerate "session not found" (the
   * server is already gone, or a racing teardown already killed it) as a
   * no-op — teardown is called from multiple paths (normal completion,
   * signal handlers) and must be idempotent.
   */
  killSession(opts: KillSessionOptions): Promise<void>

  /**
   * `tmux -L <socket> attach-session -t <session>`. Blocks until the user
   * detaches. Intended to be called from the orchestrator entrypoint.
   */
  attachSession(opts: AttachSessionOptions): Promise<void>

  /** `tmux -L <socket> select-pane -t <pane>` — focuses the target pane. */
  selectPane(opts: SelectPaneOptions): Promise<void>

  /**
   * `tmux -L <socket> capture-pane -p -t <pane> [-e] [-J]` — returns the
   * rendered pane contents. Used by observe mode for one-shot snapshots.
   */
  capturePane(opts: CapturePaneOptions): Promise<string>

  /**
   * `tmux -L <socket> pipe-pane [-O] -t <pane> <cmd>` — install or remove a
   * pipe that tees the pane's stdout into `cmd`. Passing an empty command
   * string removes the pipe.
   */
  pipePane(opts: PipePaneOptions): Promise<void>

  /**
   * `tmux -L <socket> list-panes -t <session> -F <format>` — returns the
   * format-rendered lines (one per pane). Used by observe mode to discover
   * pane ids without hand-tracking them.
   */
  listPanes(opts: ListPanesOptions): Promise<readonly string[]>

  /**
   * `tmux -L <socket> respawn-pane [-k] -t <pane> <argv...>` — replace the
   * process running inside an existing pane. Phase D's interactive hand-off
   * uses `-k` to kill any running process (the default `cat` placeholder)
   * before launching the runner argv; on step end the host respawns back to
   * `cat` to restore the placeholder for the next transcript stream.
   *
   * Argv is passed array-first; tmux never shells it out, so inputs containing
   * metacharacters are safe.
   */
  respawnPane(opts: RespawnPaneOptions): Promise<void>

  /**
   * `tmux -L <socket> unbind-key -a -T <table>` — wipe every binding in the
   * named key table. The strict-sandbox lockdown wipes `root`, `prefix`,
   * `copy-mode`, and `copy-mode-vi` so no default binding can fire
   * `send-keys -X` against a pane outside copy-mode (the source of the
   * "not in a mode" leak — tmux/tmux#638, tmux/tmux#3705).
   */
  unbindKey(opts: UnbindKeyOptions): Promise<void>

  /**
   * `tmux -L <socket> bind-key {-T <table> | -n} <key> <command> [args...]`
   * — install a single binding. Tmux's bind-key grammar takes the command
   * name as a single positional token (no `--` separator — tmux 3.6a errors
   * with "unknown command: --"). Adapters MUST reject `key` strings
   * containing `\n` or `\0` (which corrupt tmux's command stream).
   * Hardcoded callers only — see `BindKeyOptions.command`.
   */
  bindKey(opts: BindKeyOptions): Promise<void>
}
