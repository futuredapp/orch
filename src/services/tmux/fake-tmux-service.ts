import type {
  AttachSessionOptions,
  BindKeyOptions,
  CapturePaneOptions,
  CreateSessionOptions,
  DisplayMessageOptions,
  HasServerOptions,
  HasSessionOptions,
  KillPaneOptions,
  KillServerOptions,
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
  SocketName,
  SplitPaneOptions,
  SwapPaneOptions,
  TmuxService,
  UnbindKeyOptions,
  WaitForOptions,
} from './tmux-service.ts'
import { paneId, TmuxCommandError, windowId } from './tmux-service.ts'

// ---------------------------------------------------------------------------
// FakeTmuxService — hybrid command-recorder + scriptable returns
// ---------------------------------------------------------------------------
//
// Most TmuxService methods are side-effect-only, so the default shape is a
// command recorder: every call is appended to `recordedCalls` so assertions
// can verify argv construction. A few methods need scripted return values
// (`splitPane` returns a PaneId, `displayMessage` returns a string), so we
// expose setter-style helpers (`nextPaneId`, `setDisplayResult`) on top of
// the recorder.
//
// This hybrid is intentional — matches the plan's "command-recording hybrid
// (setter + spy)" requirement. FakeProcessService uses a fluent builder;
// FakeGitService uses per-key setters. Both idioms are tolerated as long as
// the pattern is self-consistent per fake.

export type RecordedCall =
  | { readonly method: 'createSession'; readonly opts: CreateSessionOptions }
  | { readonly method: 'splitPane'; readonly opts: SplitPaneOptions }
  | { readonly method: 'swapPane'; readonly opts: SwapPaneOptions }
  | { readonly method: 'sendKeys'; readonly opts: SendKeysOptions }
  | { readonly method: 'waitFor'; readonly opts: WaitForOptions }
  | { readonly method: 'signalChannel'; readonly opts: SignalChannelOptions }
  | { readonly method: 'setOption'; readonly opts: SetOptionOptions }
  | { readonly method: 'setHook'; readonly opts: SetHookOptions }
  | { readonly method: 'displayMessage'; readonly opts: DisplayMessageOptions }
  | { readonly method: 'killPane'; readonly opts: KillPaneOptions }
  | { readonly method: 'killSession'; readonly opts: KillSessionOptions }
  | { readonly method: 'killServer'; readonly opts: KillServerOptions }
  | { readonly method: 'attachSession'; readonly opts: AttachSessionOptions }
  | { readonly method: 'selectPane'; readonly opts: SelectPaneOptions }
  | { readonly method: 'capturePane'; readonly opts: CapturePaneOptions }
  | { readonly method: 'pipePane'; readonly opts: PipePaneOptions }
  | { readonly method: 'listPanes'; readonly opts: ListPanesOptions }
  | { readonly method: 'respawnPane'; readonly opts: RespawnPaneOptions }
  | { readonly method: 'unbindKey'; readonly opts: UnbindKeyOptions }
  | { readonly method: 'bindKey'; readonly opts: BindKeyOptions }
  | { readonly method: 'newWindow'; readonly opts: NewWindowOptions }
  | { readonly method: 'selectWindow'; readonly opts: SelectWindowOptions }
  | { readonly method: 'killWindow'; readonly opts: KillWindowOptions }

export class FakeTmuxService implements TmuxService {
  readonly #calls: RecordedCall[] = []
  readonly #paneIds: PaneId[] = []
  readonly #splitPaneErrors: Error[] = []
  readonly #displayResults: string[] = []
  readonly #captureResults: string[] = []
  readonly #listPanesResults: (readonly string[])[] = []
  readonly #newWindowResults: NewWindowResult[] = []
  readonly #sessionsBySocket: Map<SocketName, Set<string>> = new Map()
  #nextSplitPaneCounter = 1
  #nextWindowCounter = 1
  /** When set, every subsequent tmux call (other than the read-only
   *  `hasServer`/`hasSession` probes) throws the canonical socket-missing
   *  `TmuxCommandError`. One-way switch — see `markSocketLost`. */
  #lostSocket: SocketName | undefined

  /** Read-only view of every call received, in order. */
  get recordedCalls(): readonly RecordedCall[] {
    return this.#calls
  }

  /** Script the next `splitPane` return value. Queue, consumed FIFO. */
  nextPaneId(id: PaneId): void {
    this.#paneIds.push(id)
  }

  /**
   * Script the next `splitPane` call to throw instead of returning. Queue,
   * consumed FIFO. The call is still recorded in `recordedCalls` before the
   * throw, so assertions over the argv shape still work. Useful for testing
   * failure-recovery code paths (e.g. "no space for new pane" → window
   * rotation).
   */
  nextSplitPaneError(err: Error): void {
    this.#splitPaneErrors.push(err)
  }

  /** Script the next `displayMessage` return value. Queue, consumed FIFO. */
  setDisplayResult(value: string): void {
    this.#displayResults.push(value)
  }

  /** Script the next `capturePane` return value. Queue, consumed FIFO. */
  setCaptureResult(value: string): void {
    this.#captureResults.push(value)
  }

  /** Script the next `listPanes` return value. Queue, consumed FIFO. */
  setListPanesResult(value: readonly string[]): void {
    this.#listPanesResults.push(value)
  }

  /** Script the next `newWindow` return value. Queue, consumed FIFO. */
  nextNewWindowResult(value: NewWindowResult): void {
    this.#newWindowResults.push(value)
  }

  /**
   * Mark the per-run tmux server as lost. From this point on every mutating
   * tmux call throws the canonical macOS socket-missing `TmuxCommandError`
   * — the exact shape orch sees when the tmux server dies underneath a live
   * run (incident r-2026-05-22-093650-j0).
   *
   * `hasServer` / `hasSession` remain queryable and simply report `false`;
   * the in-memory session table is also cleared so callers that probe
   * reachability via the boolean accessors get a coherent "everything is
   * gone" picture. The `socket` argument names the lost server — used to
   * build the stderr string that the `TMUX_SESSION_LOST_PATTERN` regex
   * keys off of.
   */
  markSocketLost(socket: SocketName): void {
    this.#lostSocket = socket
    this.#sessionsBySocket.delete(socket)
  }

  /** Throw if a socket has been marked lost. Called from every mutating
   *  method's prelude so we mimic real tmux's blanket failure. */
  #failIfSocketLost(method: string): void {
    if (this.#lostSocket === undefined) return
    const stderr = `error connecting to /private/tmp/tmux-501/${this.#lostSocket} (No such file or directory)`
    throw new TmuxCommandError(1, stderr, `tmux ${method} failed (exit 1): ${stderr}`)
  }

  async createSession(opts: CreateSessionOptions): Promise<void> {
    this.#calls.push({ method: 'createSession', opts })
    this.#failIfSocketLost('new-session')
    this.#getOrCreateSessionSet(opts.socket).add(opts.session)
  }

  async splitPane(opts: SplitPaneOptions): Promise<PaneId> {
    this.#calls.push({ method: 'splitPane', opts })
    this.#failIfSocketLost('split-window')
    const scriptedError = this.#splitPaneErrors.shift()
    if (scriptedError !== undefined) throw scriptedError
    const scripted = this.#paneIds.shift()
    if (scripted !== undefined) return scripted
    const synthetic = paneId(`%${this.#nextSplitPaneCounter++}`)
    return synthetic
  }

  async swapPane(opts: SwapPaneOptions): Promise<void> {
    this.#calls.push({ method: 'swapPane', opts })
    this.#failIfSocketLost('swap-pane')
  }

  async sendKeys(opts: SendKeysOptions): Promise<void> {
    this.#calls.push({ method: 'sendKeys', opts })
    this.#failIfSocketLost('send-keys')
  }

  async waitFor(opts: WaitForOptions): Promise<void> {
    this.#calls.push({ method: 'waitFor', opts })
    this.#failIfSocketLost('wait-for')
  }

  async signalChannel(opts: SignalChannelOptions): Promise<void> {
    this.#calls.push({ method: 'signalChannel', opts })
    this.#failIfSocketLost('wait-for')
  }

  async setOption(opts: SetOptionOptions): Promise<void> {
    this.#calls.push({ method: 'setOption', opts })
    this.#failIfSocketLost('set-option')
  }

  async setHook(opts: SetHookOptions): Promise<void> {
    this.#calls.push({ method: 'setHook', opts })
    this.#failIfSocketLost('set-hook')
  }

  async displayMessage(opts: DisplayMessageOptions): Promise<string> {
    this.#calls.push({ method: 'displayMessage', opts })
    this.#failIfSocketLost('display-message')
    const scripted = this.#displayResults.shift()
    if (scripted === undefined) {
      throw new Error(
        `FakeTmuxService: no displayMessage result scripted (target=${opts.target}, format=${JSON.stringify(opts.format)})`,
      )
    }
    return scripted
  }

  async killPane(opts: KillPaneOptions): Promise<void> {
    this.#calls.push({ method: 'killPane', opts })
    this.#failIfSocketLost('kill-pane')
  }

  async killSession(opts: KillSessionOptions): Promise<void> {
    this.#calls.push({ method: 'killSession', opts })
    this.#failIfSocketLost('kill-session')
    this.#sessionsBySocket.get(opts.socket)?.delete(opts.session)
  }

  async killServer(opts: KillServerOptions): Promise<void> {
    this.#calls.push({ method: 'killServer', opts })
    // kill-server is intentionally NOT gated by `#failIfSocketLost` — the
    // adapter's contract is to tolerate "no server running" as a no-op,
    // matching the real tmux behavior. After a successful kill-server, the
    // socket is gone; we mirror that by clearing the per-socket session
    // table and (idempotently) leaving the lost-socket sentinel as-is.
    this.#sessionsBySocket.delete(opts.socket)
  }

  async hasSession(opts: HasSessionOptions): Promise<boolean> {
    const set = this.#sessionsBySocket.get(opts.socket)
    if (set === undefined) return false
    return set.has(opts.session)
  }

  async hasServer(opts: HasServerOptions): Promise<boolean> {
    const set = this.#sessionsBySocket.get(opts.socket)
    return set !== undefined && set.size > 0
  }

  /**
   * Set the in-memory session table for `socket`. Tests use this to script
   * `hasSession` / `hasServer` without going through `createSession`. Pass
   * `undefined` (or omit the call) to mark the server as down.
   */
  setSessions(socket: SocketName, sessions: readonly string[] | undefined): void {
    if (sessions === undefined || sessions.length === 0) {
      this.#sessionsBySocket.delete(socket)
      return
    }
    this.#sessionsBySocket.set(socket, new Set(sessions))
  }

  #getOrCreateSessionSet(socket: SocketName): Set<string> {
    let set = this.#sessionsBySocket.get(socket)
    if (set === undefined) {
      set = new Set<string>()
      this.#sessionsBySocket.set(socket, set)
    }
    return set
  }

  async attachSession(opts: AttachSessionOptions): Promise<void> {
    this.#calls.push({ method: 'attachSession', opts })
    this.#failIfSocketLost('attach-session')
  }

  async selectPane(opts: SelectPaneOptions): Promise<void> {
    this.#calls.push({ method: 'selectPane', opts })
    this.#failIfSocketLost('select-pane')
  }

  async capturePane(opts: CapturePaneOptions): Promise<string> {
    this.#calls.push({ method: 'capturePane', opts })
    this.#failIfSocketLost('capture-pane')
    const scripted = this.#captureResults.shift()
    return scripted ?? ''
  }

  async pipePane(opts: PipePaneOptions): Promise<void> {
    this.#calls.push({ method: 'pipePane', opts })
    this.#failIfSocketLost('pipe-pane')
  }

  async listPanes(opts: ListPanesOptions): Promise<readonly string[]> {
    this.#calls.push({ method: 'listPanes', opts })
    this.#failIfSocketLost('list-panes')
    const scripted = this.#listPanesResults.shift()
    return scripted ?? []
  }

  async respawnPane(opts: RespawnPaneOptions): Promise<void> {
    this.#calls.push({ method: 'respawnPane', opts })
    this.#failIfSocketLost('respawn-pane')
  }

  async unbindKey(opts: UnbindKeyOptions): Promise<void> {
    this.#calls.push({ method: 'unbindKey', opts })
    this.#failIfSocketLost('unbind-key')
  }

  async bindKey(opts: BindKeyOptions): Promise<void> {
    this.#calls.push({ method: 'bindKey', opts })
    this.#failIfSocketLost('bind-key')
  }

  async newWindow(opts: NewWindowOptions): Promise<NewWindowResult> {
    this.#calls.push({ method: 'newWindow', opts })
    this.#failIfSocketLost('new-window')
    const scripted = this.#newWindowResults.shift()
    if (scripted !== undefined) return scripted
    const wid = windowId(`@${this.#nextWindowCounter}`)
    const pid = paneId(`%${100 + this.#nextWindowCounter}`)
    this.#nextWindowCounter++
    return { windowId: wid, paneId: pid }
  }

  async selectWindow(opts: SelectWindowOptions): Promise<void> {
    this.#calls.push({ method: 'selectWindow', opts })
    this.#failIfSocketLost('select-window')
  }

  async killWindow(opts: KillWindowOptions): Promise<void> {
    this.#calls.push({ method: 'killWindow', opts })
    this.#failIfSocketLost('kill-window')
  }
}
