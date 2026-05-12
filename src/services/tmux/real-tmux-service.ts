// Named `RealTmuxService` (not `BunTmuxService`) because it wraps
// `ProcessService`, not `Bun.spawn` directly. The runtime seam lives in
// `ProcessService` — `RealTmuxService` only composes tmux argv.

import type { ProcessService } from '../process/index.ts'
import { path } from '../types.ts'
import type {
  AttachSessionOptions,
  BindKeyOptions,
  CapturePaneOptions,
  CreateSessionOptions,
  DisplayMessageOptions,
  KillPaneOptions,
  KillSessionOptions,
  KillWindowOptions,
  ListPanesOptions,
  NewWindowOptions,
  NewWindowResult,
  PaneId,
  PipePaneOptions,
  RespawnPaneOptions,
  SelectPaneOptions,
  SelectWindowOptions,
  SendKeysOptions,
  SetHookOptions,
  SetOptionOptions,
  SignalChannelOptions,
  SplitPaneOptions,
  SwapPaneOptions,
  TmuxService,
  UnbindKeyOptions,
  WaitForOptions,
} from './tmux-service.ts'
import { paneId, TmuxCommandError, windowId } from './tmux-service.ts'

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------
//
// The tmux server inherits the orch process's full env (passthrough). This is
// the load-bearing fix for macOS keychain bootstrap vars (`SECURITYSESSIONID`,
// `__CFBundleIdentifier`, …) reaching child processes spawned inside panes —
// without them, an interactive Claude pane prompts "Please run /login" even
// when the host shell is logged in. `TMUX` / `TMUX_PANE` are dangerous if orch
// was launched from inside another tmux client; the `assertNoNestedTmux` guard
// in two-pane host blocks that case before the server is created, so
// passthrough is safe in practice.

const buildPassthroughEnv = (): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v
  }
  return env
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_STDERR_LEN = 500

const truncateStderr = (stderr: string): string =>
  stderr.length > MAX_STDERR_LEN ? `${stderr.slice(0, MAX_STDERR_LEN)}…` : stderr

const fail = (exitCode: number, stderr: string, prefix: string): TmuxCommandError => {
  const redacted = truncateStderr(stderr)
  return new TmuxCommandError(exitCode, redacted, `${prefix} (exit ${exitCode}): ${redacted}`)
}

const appendEnvFlags = (
  argv: string[],
  env: Readonly<Record<string, string>>,
  prefix: string,
): void => {
  for (const [k, v] of Object.entries(env)) {
    // `=` or newline in a key corrupts the `-e KEY=VAL` argv shape (tmux
    // splits on the first `=` only). Values pass through verbatim.
    if (k.includes('=') || k.includes('\n')) {
      throw new Error(`${prefix}: env key ${JSON.stringify(k)} contains '=' or newline`)
    }
    argv.push('-e', `${k}=${v}`)
  }
}

const assertNoNullByteArgv = (entries: readonly string[], prefix: string): void => {
  for (const a of entries) {
    if (a.includes('\0')) {
      throw new Error(`${prefix}: argv element ${JSON.stringify(a)} contains '\\0'`)
    }
  }
}

// ---------------------------------------------------------------------------
// RealTmuxService
// ---------------------------------------------------------------------------

export class RealTmuxService implements TmuxService {
  readonly #processService: ProcessService

  constructor(deps: { readonly processService: ProcessService }) {
    this.#processService = deps.processService
  }

  async createSession(opts: CreateSessionOptions): Promise<void> {
    // `-f <path>` is load-bearing for `history-limit 0` (tmux/tmux#4705 —
    // captured at pane allocation, so a post-create `set -g` does not shrink
    // the initial pane). The strict-sandbox path supplies a generated config
    // file via `opts.configPath`; callers that don't need that pin keep the
    // historical `/dev/null` to ignore the user's `~/.tmux.conf`.
    // `-d` — detached. Orchestrator attaches later from a different call.
    const configPath = opts.configPath ?? '/dev/null'
    const argv = [
      'tmux',
      '-L',
      opts.socket,
      '-f',
      configPath,
      'new-session',
      '-d',
      '-s',
      opts.session,
      '-x',
      String(opts.width),
      '-y',
      String(opts.height),
    ]
    const { stderr, exitCode } = await this.#run(argv)
    if (exitCode !== 0) throw fail(exitCode, stderr, 'tmux new-session failed')
  }

  async splitPane(opts: SplitPaneOptions): Promise<PaneId> {
    const orientationFlag = opts.orientation === 'h' ? '-h' : '-v'
    const argv: string[] = [
      'tmux',
      '-L',
      opts.socket,
      'split-window',
      '-t',
      opts.session,
      orientationFlag,
      '-p',
      String(opts.percent),
      '-P',
      '-F',
      '#{pane_id}',
    ]
    if (opts.argv !== undefined) {
      // argv variant — env, cwd, and array argv. tmux concatenates trailing
      // argv into the shell-command position, so push it last.
      if (opts.env !== undefined) appendEnvFlags(argv, opts.env, 'splitPane')
      if (opts.cwd !== undefined) argv.push('-c', opts.cwd)
      assertNoNullByteArgv(opts.argv, 'splitPane')
      argv.push(...opts.argv)
    } else if (opts.command !== undefined) {
      argv.push(opts.command)
    }

    const { stdout, stderr, exitCode } = await this.#run(argv)
    if (exitCode !== 0) throw fail(exitCode, stderr, 'tmux split-window failed')

    const first = stdout.split('\n').find((l) => l.trim().length > 0) ?? ''
    const trimmed = first.trim()
    try {
      return paneId(trimmed)
    } catch {
      throw new TmuxCommandError(
        exitCode,
        truncateStderr(stderr),
        `tmux split-window returned unexpected pane id: ${JSON.stringify(trimmed)}`,
      )
    }
  }

  async swapPane(opts: SwapPaneOptions): Promise<void> {
    // `-d` is load-bearing: without it, tmux moves the active pane to `src`
    // after the swap. Our only caller swaps a hidden scratch pane into the
    // visible right-pane slot, which would steal focus from the steps-view
    // left pane on every step open / live-source register. Keep focus put.
    const argv = ['tmux', '-L', opts.socket, 'swap-pane', '-d', '-s', opts.src, '-t', opts.dst]
    const { stderr, exitCode } = await this.#run(argv)
    if (exitCode !== 0) throw fail(exitCode, stderr, 'tmux swap-pane failed')
  }

  async sendKeys(opts: SendKeysOptions): Promise<void> {
    const argv = ['tmux', '-L', opts.socket, 'send-keys', '-t', opts.target, '-l', ...opts.keys]
    const { stderr, exitCode } = await this.#run(argv)
    if (exitCode !== 0) throw fail(exitCode, stderr, 'tmux send-keys failed')

    if (opts.enter === true) {
      const enterArgv = ['tmux', '-L', opts.socket, 'send-keys', '-t', opts.target, 'Enter']
      const enterResult = await this.#run(enterArgv)
      if (enterResult.exitCode !== 0) {
        throw fail(enterResult.exitCode, enterResult.stderr, 'tmux send-keys Enter failed')
      }
    }
  }

  async waitFor(opts: WaitForOptions): Promise<void> {
    // tmux `wait-for` has no native timeout. When the caller asks for a hard
    // cap, race against a timer so autonomous waits fail loud instead of
    // hanging forever. When `timeoutMs` is omitted, wait indefinitely —
    // interactive steps need this so the user can pause the agent for
    // arbitrary periods without orch killing the run.
    const argv = ['tmux', '-L', opts.socket, 'wait-for', opts.channel]
    const run = this.#run(argv)

    if (opts.timeoutMs === undefined) {
      const { stderr, exitCode } = await run
      if (exitCode !== 0) throw fail(exitCode, stderr, 'tmux wait-for failed')
      return
    }

    const timeoutMs = opts.timeoutMs
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs)
    })

    const winner = await Promise.race([run.then(() => 'done' as const), timeout])
    if (timer !== undefined) clearTimeout(timer)

    if (winner === 'timeout') {
      throw new TmuxCommandError(
        -1,
        '',
        `tmux wait-for ${opts.channel} timed out after ${timeoutMs}ms`,
      )
    }

    const { stderr, exitCode } = await run
    if (exitCode !== 0) throw fail(exitCode, stderr, 'tmux wait-for failed')
  }

  async signalChannel(opts: SignalChannelOptions): Promise<void> {
    const argv = ['tmux', '-L', opts.socket, 'wait-for', '-S', opts.channel]
    const { stderr, exitCode } = await this.#run(argv)
    if (exitCode !== 0) throw fail(exitCode, stderr, 'tmux wait-for -S failed')
  }

  async setOption(opts: SetOptionOptions): Promise<void> {
    const argv = ['tmux', '-L', opts.socket, 'set-option']
    if (opts.global === true) {
      argv.push('-g')
    } else {
      argv.push('-t', opts.target)
    }
    argv.push(opts.name, opts.value)

    const { stderr, exitCode } = await this.#run(argv)
    if (exitCode !== 0) throw fail(exitCode, stderr, 'tmux set-option failed')
  }

  async setHook(opts: SetHookOptions): Promise<void> {
    const argv = ['tmux', '-L', opts.socket, 'set-hook', '-g', opts.hook, opts.command]
    const { stderr, exitCode } = await this.#run(argv)
    if (exitCode !== 0) throw fail(exitCode, stderr, 'tmux set-hook failed')
  }

  async displayMessage(opts: DisplayMessageOptions): Promise<string> {
    const argv = [
      'tmux',
      '-L',
      opts.socket,
      'display-message',
      '-p',
      '-t',
      opts.target,
      opts.format,
    ]
    const { stdout, stderr, exitCode } = await this.#run(argv)
    if (exitCode !== 0) throw fail(exitCode, stderr, 'tmux display-message failed')

    // tmux returns exit 0 with EMPTY stdout when the target pane is gone.
    // Treat empty output as a structural error — callers rely on non-empty
    // strings to make lifecycle decisions.
    const trimmed = stdout.replace(/\n$/, '')
    if (trimmed.length === 0) {
      throw new TmuxCommandError(
        0,
        '',
        `tmux display-message returned empty output — target pane ${opts.target} is not valid`,
      )
    }
    return trimmed
  }

  async killPane(opts: KillPaneOptions): Promise<void> {
    const argv = ['tmux', '-L', opts.socket, 'kill-pane', '-t', opts.target]
    const { stderr, exitCode } = await this.#run(argv)
    if (exitCode !== 0) throw fail(exitCode, stderr, 'tmux kill-pane failed')
  }

  async killSession(opts: KillSessionOptions): Promise<void> {
    // Teardown is idempotent by design — "session not found" and "no server
    // running" both mean "already gone", which is the outcome we want.
    // Anything else (malformed argv, permissions) surfaces as a real failure.
    const argv = ['tmux', '-L', opts.socket, 'kill-session', '-t', opts.session]
    const { stderr, exitCode } = await this.#run(argv)
    if (exitCode === 0) return
    if (/session not found|no server running|can't find session/i.test(stderr)) return
    throw fail(exitCode, stderr, 'tmux kill-session failed')
  }

  async attachSession(opts: AttachSessionOptions): Promise<void> {
    // Note: this is used from inside workflows where stdin/stdout are not
    // inherited — tmux still works over the control socket. For a real
    // interactive attach we expect callers to use `spawnForeground` directly.
    const argv = ['tmux', '-L', opts.socket, 'attach-session', '-t', opts.session]
    const { stderr, exitCode } = await this.#run(argv)
    if (exitCode !== 0) throw fail(exitCode, stderr, 'tmux attach-session failed')
  }

  async selectPane(opts: SelectPaneOptions): Promise<void> {
    const argv = ['tmux', '-L', opts.socket, 'select-pane', '-t', opts.target]
    const { stderr, exitCode } = await this.#run(argv)
    if (exitCode !== 0) throw fail(exitCode, stderr, 'tmux select-pane failed')
  }

  async capturePane(opts: CapturePaneOptions): Promise<string> {
    const argv = ['tmux', '-L', opts.socket, 'capture-pane', '-p', '-t', opts.target]
    if (opts.escapeCodes === true) argv.push('-e')
    if (opts.joinWrapped === true) argv.push('-J')

    const { stdout, stderr, exitCode } = await this.#run(argv)
    if (exitCode !== 0) throw fail(exitCode, stderr, 'tmux capture-pane failed')
    return stdout
  }

  async pipePane(opts: PipePaneOptions): Promise<void> {
    // Empty command removes an existing pipe (tmux's native semantics). We
    // still pass it positionally so the shape stays uniform.
    const argv = ['tmux', '-L', opts.socket, 'pipe-pane']
    if (opts.append === true) argv.push('-O')
    argv.push('-t', opts.target, opts.command)

    const { stderr, exitCode } = await this.#run(argv)
    if (exitCode !== 0) throw fail(exitCode, stderr, 'tmux pipe-pane failed')
  }

  async listPanes(opts: ListPanesOptions): Promise<readonly string[]> {
    const argv = ['tmux', '-L', opts.socket, 'list-panes', '-t', opts.session, '-F', opts.format]
    const { stdout, stderr, exitCode } = await this.#run(argv)
    if (exitCode !== 0) throw fail(exitCode, stderr, 'tmux list-panes failed')
    return stdout.split('\n').filter((line) => line.length > 0)
  }

  async respawnPane(opts: RespawnPaneOptions): Promise<void> {
    // Array-only argv — tmux passes each element verbatim to execvp so
    // metacharacters in step names or prompts can never inject. `-k` kills
    // any running process (the default `cat` placeholder) before respawn.
    const argv: string[] = ['tmux', '-L', opts.socket, 'respawn-pane']
    if (opts.killRunning) argv.push('-k')
    if (opts.env !== undefined) {
      for (const [k, v] of Object.entries(opts.env)) {
        // `=` and newline in the key would split or terminate the `-e KEY=VAL`
        // argv that tmux parses. Values pass through verbatim — tmux handles
        // them, including `=` inside the value (only the first split matters).
        if (k.includes('=') || k.includes('\n')) {
          throw new Error(`respawnPane: env key ${JSON.stringify(k)} contains '=' or newline`)
        }
        argv.push('-e', `${k}=${v}`)
      }
    }
    if (opts.cwd !== undefined) argv.push('-c', opts.cwd)
    argv.push('-t', opts.target, ...opts.argv)

    const { stderr, exitCode } = await this.#run(argv)
    if (exitCode !== 0) throw fail(exitCode, stderr, 'tmux respawn-pane failed')
  }

  async unbindKey(opts: UnbindKeyOptions): Promise<void> {
    const argv = ['tmux', '-L', opts.socket, 'unbind-key', '-a', '-T', opts.table]
    const { stderr, exitCode } = await this.#run(argv)
    if (exitCode !== 0) throw fail(exitCode, stderr, 'tmux unbind-key failed')
  }

  async newWindow(opts: NewWindowOptions): Promise<NewWindowResult> {
    const argv: string[] = [
      'tmux',
      '-L',
      opts.socket,
      'new-window',
      '-d',
      '-a',
      '-t',
      opts.session,
      '-n',
      opts.name,
      '-c',
      opts.cwd,
      '-P',
      '-F',
      '#{window_id}\t#{pane_id}',
    ]
    if (opts.env !== undefined) {
      for (const [k, v] of Object.entries(opts.env)) {
        if (k.includes('=') || k.includes('\n')) {
          throw new Error(`newWindow: env key ${JSON.stringify(k)} contains '=' or newline`)
        }
        argv.push('-e', `${k}=${v}`)
      }
    }
    if (opts.argv !== undefined && opts.argv.length > 0) {
      argv.push(...opts.argv)
    } else {
      argv.push('cat')
    }

    const { stdout, stderr, exitCode } = await this.#run(argv)
    if (exitCode !== 0) throw fail(exitCode, stderr, 'tmux new-window failed')

    const first = stdout.split('\n').find((l) => l.trim().length > 0) ?? ''
    const parts = first.split('\t')
    const wid = parts[0]?.trim() ?? ''
    const pid = parts[1]?.trim() ?? ''
    if (wid.length === 0 || pid.length === 0) {
      throw new TmuxCommandError(
        exitCode,
        truncateStderr(stderr),
        `tmux new-window returned unexpected output: ${JSON.stringify(first)}`,
      )
    }
    const result: NewWindowResult = { windowId: windowId(wid), paneId: paneId(pid) }
    // Pin `automatic-rename off` belt-and-braces against OSC sequences in the
    // replay payload re-enabling it. Failure here is non-fatal — log via stderr
    // path? — actually just bubble up; this is internal-only argv, the callsite
    // already accepts a TmuxCommandError from new-window.
    const setArgv = [
      'tmux',
      '-L',
      opts.socket,
      'set-option',
      '-t',
      result.windowId,
      'automatic-rename',
      'off',
    ]
    const setRes = await this.#run(setArgv)
    if (setRes.exitCode !== 0) {
      throw fail(setRes.exitCode, setRes.stderr, 'tmux set-option automatic-rename failed')
    }
    return result
  }

  async selectWindow(opts: SelectWindowOptions): Promise<void> {
    const argv = ['tmux', '-L', opts.socket, 'select-window', '-t', opts.target]
    const { stderr, exitCode } = await this.#run(argv)
    if (exitCode !== 0) throw fail(exitCode, stderr, 'tmux select-window failed')
  }

  async killWindow(opts: KillWindowOptions): Promise<void> {
    const argv = ['tmux', '-L', opts.socket, 'kill-window', '-t', opts.target]
    const { stderr, exitCode } = await this.#run(argv)
    if (exitCode === 0) return
    if (/can't find window|window not found/i.test(stderr)) return
    throw fail(exitCode, stderr, 'tmux kill-window failed')
  }

  async bindKey(opts: BindKeyOptions): Promise<void> {
    // tmux's command stream is line-oriented; a NUL or newline in `key`
    // would corrupt argv. Reject loudly — the single caller passes
    // hardcoded constants, so this only ever fires on a programming bug.
    if (opts.key.includes('\n') || opts.key.includes('\0')) {
      throw new Error(`bindKey: key ${JSON.stringify(opts.key)} contains '\\n' or '\\0'`)
    }

    // Tmux 3.6a's `bind-key` does NOT accept `--` between the key and the
    // command argv (verified empirically — `bind-key … -- resize-pane -M`
    // fails with "unknown command: --"). The grammar is
    // `bind-key [-nr] [-N note] [-T table] key command [args...]`, where
    // `command` is one positional token (the tmux command name). We pass
    // argv directly and rely on the BindKeyOptions contract — hardcoded
    // constants only — to keep injection out of the picture.
    const argv = ['tmux', '-L', opts.socket, 'bind-key']
    if (opts.table === 'root-no-prefix') {
      argv.push('-n')
    } else {
      argv.push('-T', opts.table)
    }
    argv.push(opts.key, ...opts.command)

    const { stderr, exitCode } = await this.#run(argv)
    if (exitCode !== 0) throw fail(exitCode, stderr, 'tmux bind-key failed')
  }

  async #run(
    argv: readonly string[],
  ): Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }> {
    const handle = this.#processService.spawn({
      argv,
      // tmux commands run against the server socket, not a filesystem path;
      // any existing directory works. `/` is always valid.
      cwd: path('/'),
      env: buildPassthroughEnv(),
    })

    const stdoutPromise = (async () => {
      const parts: string[] = []
      for await (const line of handle.stdout) parts.push(line)
      return parts.join('\n')
    })()

    const stderrPromise = (async () => {
      const parts: string[] = []
      for await (const line of handle.stderr) parts.push(line)
      return parts.join('\n')
    })()

    const [stdout, stderr, waitResult] = await Promise.all([
      stdoutPromise,
      stderrPromise,
      handle.wait(),
    ])
    return { stdout, stderr, exitCode: waitResult.exitCode }
  }
}
