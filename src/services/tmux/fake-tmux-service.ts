import type {
  AttachSessionOptions,
  BindKeyOptions,
  CapturePaneOptions,
  CreateSessionOptions,
  DisplayMessageOptions,
  HasServerOptions,
  HasSessionOptions,
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
  SocketName,
  SplitPaneOptions,
  SwapPaneOptions,
  TmuxService,
  UnbindKeyOptions,
  WaitForOptions,
} from './tmux-service.ts'
import { paneId, windowId } from './tmux-service.ts'

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
  readonly #displayResults: string[] = []
  readonly #captureResults: string[] = []
  readonly #listPanesResults: (readonly string[])[] = []
  readonly #newWindowResults: NewWindowResult[] = []
  readonly #sessionsBySocket: Map<SocketName, Set<string>> = new Map()
  #nextSplitPaneCounter = 1
  #nextWindowCounter = 1

  /** Read-only view of every call received, in order. */
  get recordedCalls(): readonly RecordedCall[] {
    return this.#calls
  }

  /** Script the next `splitPane` return value. Queue, consumed FIFO. */
  nextPaneId(id: PaneId): void {
    this.#paneIds.push(id)
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

  async createSession(opts: CreateSessionOptions): Promise<void> {
    this.#calls.push({ method: 'createSession', opts })
    this.#getOrCreateSessionSet(opts.socket).add(opts.session)
  }

  async splitPane(opts: SplitPaneOptions): Promise<PaneId> {
    this.#calls.push({ method: 'splitPane', opts })
    const scripted = this.#paneIds.shift()
    if (scripted !== undefined) return scripted
    const synthetic = paneId(`%${this.#nextSplitPaneCounter++}`)
    return synthetic
  }

  async swapPane(opts: SwapPaneOptions): Promise<void> {
    this.#calls.push({ method: 'swapPane', opts })
  }

  async sendKeys(opts: SendKeysOptions): Promise<void> {
    this.#calls.push({ method: 'sendKeys', opts })
  }

  async waitFor(opts: WaitForOptions): Promise<void> {
    this.#calls.push({ method: 'waitFor', opts })
  }

  async signalChannel(opts: SignalChannelOptions): Promise<void> {
    this.#calls.push({ method: 'signalChannel', opts })
  }

  async setOption(opts: SetOptionOptions): Promise<void> {
    this.#calls.push({ method: 'setOption', opts })
  }

  async setHook(opts: SetHookOptions): Promise<void> {
    this.#calls.push({ method: 'setHook', opts })
  }

  async displayMessage(opts: DisplayMessageOptions): Promise<string> {
    this.#calls.push({ method: 'displayMessage', opts })
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
  }

  async killSession(opts: KillSessionOptions): Promise<void> {
    this.#calls.push({ method: 'killSession', opts })
    this.#sessionsBySocket.get(opts.socket)?.delete(opts.session)
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
  }

  async selectPane(opts: SelectPaneOptions): Promise<void> {
    this.#calls.push({ method: 'selectPane', opts })
  }

  async capturePane(opts: CapturePaneOptions): Promise<string> {
    this.#calls.push({ method: 'capturePane', opts })
    const scripted = this.#captureResults.shift()
    return scripted ?? ''
  }

  async pipePane(opts: PipePaneOptions): Promise<void> {
    this.#calls.push({ method: 'pipePane', opts })
  }

  async listPanes(opts: ListPanesOptions): Promise<readonly string[]> {
    this.#calls.push({ method: 'listPanes', opts })
    const scripted = this.#listPanesResults.shift()
    return scripted ?? []
  }

  async respawnPane(opts: RespawnPaneOptions): Promise<void> {
    this.#calls.push({ method: 'respawnPane', opts })
  }

  async unbindKey(opts: UnbindKeyOptions): Promise<void> {
    this.#calls.push({ method: 'unbindKey', opts })
  }

  async bindKey(opts: BindKeyOptions): Promise<void> {
    this.#calls.push({ method: 'bindKey', opts })
  }

  async newWindow(opts: NewWindowOptions): Promise<NewWindowResult> {
    this.#calls.push({ method: 'newWindow', opts })
    const scripted = this.#newWindowResults.shift()
    if (scripted !== undefined) return scripted
    const wid = windowId(`@${this.#nextWindowCounter}`)
    const pid = paneId(`%${100 + this.#nextWindowCounter}`)
    this.#nextWindowCounter++
    return { windowId: wid, paneId: pid }
  }

  async selectWindow(opts: SelectWindowOptions): Promise<void> {
    this.#calls.push({ method: 'selectWindow', opts })
  }

  async killWindow(opts: KillWindowOptions): Promise<void> {
    this.#calls.push({ method: 'killWindow', opts })
  }
}
