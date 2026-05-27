import type {
  AttachSessionOptions,
  BindKeyOptions,
  CapturePaneOptions,
  CreateSessionOptions,
  CreateSessionResult,
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
  readonly #createSessionPaneIds: PaneId[] = []
  readonly #splitPaneErrors: Error[] = []
  readonly #createSessionErrors: Error[] = []
  readonly #displayResults: string[] = []
  #waitForHolds = 0
  readonly #captureResults: string[] = []
  readonly #listPanesResults: (readonly string[])[] = []
  readonly #newWindowResults: NewWindowResult[] = []
  readonly #sessionsBySocket: Map<SocketName, Set<string>> = new Map()
  /**
   * Per-session pane-ownership table. `createSession` appends the (scripted
   * or synthesized) initial pane id; `killSession` clears the entry;
   * `killServer` clears every session on that socket. The pane-map refactor
   * relies on this so tests can assert "after killSession(orch-src-X), pane
   * %N is no longer owned by a session" without those assertions becoming
   * wishful thinking — the seam-bug class that hid the rotation problem
   * (FakeTmuxService had no pane-to-session mapping) needs an actual model.
   * Keyed by `${socket}/${session}` so two sockets with same-named sessions
   * stay distinct.
   */
  readonly #panesBySession: Map<string, PaneId[]> = new Map()
  /**
   * Panes whose process has exited but whose containing session is still alive
   * (real tmux with `remain-on-exit on` leaves the dead pane lingering). A swap
   * touching such a pane throws the canonical "can't find pane" error, while
   * `hasSession` keeps reporting the session as alive — the exact condition a
   * session-granular liveness check cannot detect.
   */
  readonly #deadPanes: Set<string> = new Set()
  #nextCreateSessionCounter = 1
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
   * Script the next `createSession` initial-pane id. Queue, consumed FIFO.
   * Falls back to `%N` auto-synth when the queue is empty. Mirrors
   * `nextPaneId` for `splitPane` — used by tests that assert on a specific
   * pane id for the per-source session's initial (holder or source) pane.
   */
  nextCreateSessionPaneId(id: PaneId): void {
    this.#createSessionPaneIds.push(id)
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

  /**
   * Script the next `createSession` call to throw instead of returning.
   * Queue, consumed FIFO. The call is still recorded in `recordedCalls`
   * before the throw. Used by per-source session tests to model a single
   * source's session-create failure — the controller's failure-isolation
   * contract says sibling sources are unaffected.
   */
  nextCreateSessionError(err: Error): void {
    this.#createSessionErrors.push(err)
  }

  /**
   * Read-only view of the pane ids owned by `socket`/`session`. Returns an
   * empty array for unknown sessions. Used by tests that assert
   * `killSession` cleared the table.
   */
  paneIdsForSession(socket: SocketName, session: string): readonly PaneId[] {
    return this.#panesBySession.get(`${socket}/${session}`) ?? []
  }

  /** Script the next `displayMessage` return value. Queue, consumed FIFO. */
  setDisplayResult(value: string): void {
    this.#displayResults.push(value)
  }

  /**
   * Make the next `count` `waitFor` calls hang forever (never resolve),
   * mimicking a `pane-died` hook signal that is lost or arrives so late the
   * caller's backstop must observe the exit another way. Consumed FIFO — each
   * held call decrements the budget. Use with `FakeClock` so the racing poll
   * can win deterministically via `advance()`.
   */
  holdNextWaitFor(count = 1): void {
    this.#waitForHolds += count
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

  async createSession(opts: CreateSessionOptions): Promise<CreateSessionResult> {
    this.#calls.push({ method: 'createSession', opts })
    this.#failIfSocketLost('new-session')
    const scriptedError = this.#createSessionErrors.shift()
    if (scriptedError !== undefined) throw scriptedError
    this.#getOrCreateSessionSet(opts.socket).add(opts.session)
    const scripted = this.#createSessionPaneIds.shift()
    const id = scripted ?? paneId(`%${this.#nextCreateSessionCounter++}`)
    const key = `${opts.socket}/${opts.session}`
    const existing = this.#panesBySession.get(key)
    if (existing !== undefined) {
      existing.push(id)
    } else {
      this.#panesBySession.set(key, [id])
    }
    return { paneId: id }
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

  /**
   * Mark a pane as dead-but-lingering: its process exited, but `remain-on-exit`
   * keeps the pane (and its session) present. Subsequent `swapPane` calls that
   * reference it throw "can't find pane" while `hasSession` still returns true.
   */
  markPaneDead(id: PaneId): void {
    this.#deadPanes.add(String(id))
  }

  async swapPane(opts: SwapPaneOptions): Promise<void> {
    this.#calls.push({ method: 'swapPane', opts })
    this.#failIfSocketLost('swap-pane')
    for (const target of [opts.src, opts.dst]) {
      if (this.#deadPanes.has(String(target))) {
        const stderr = `can't find pane: ${target}`
        throw new TmuxCommandError(1, stderr, `tmux swap-pane failed (exit 1): ${stderr}`)
      }
    }
  }

  async sendKeys(opts: SendKeysOptions): Promise<void> {
    this.#calls.push({ method: 'sendKeys', opts })
    this.#failIfSocketLost('send-keys')
  }

  async waitFor(opts: WaitForOptions): Promise<void> {
    this.#calls.push({ method: 'waitFor', opts })
    this.#failIfSocketLost('wait-for')
    if (this.#waitForHolds > 0) {
      this.#waitForHolds -= 1
      // Never resolves — the caller must observe completion via another path
      // (e.g. a liveness poll). Modelled as the lost-hook-signal case.
      await new Promise<never>(() => {})
    }
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
    this.#panesBySession.delete(`${opts.socket}/${opts.session}`)
  }

  async killServer(opts: KillServerOptions): Promise<void> {
    this.#calls.push({ method: 'killServer', opts })
    // kill-server is intentionally NOT gated by `#failIfSocketLost` — the
    // adapter's contract is to tolerate "no server running" as a no-op,
    // matching the real tmux behavior. After a successful kill-server, the
    // socket is gone; we mirror that by clearing the per-socket session
    // table and (idempotently) leaving the lost-socket sentinel as-is.
    this.#sessionsBySocket.delete(opts.socket)
    // Drop every pane-ownership entry on this socket. The map keys are
    // `${socket}/${session}` so a prefix scan is the cleanest path.
    const prefix = `${opts.socket}/`
    for (const key of this.#panesBySession.keys()) {
      if (key.startsWith(prefix)) this.#panesBySession.delete(key)
    }
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
