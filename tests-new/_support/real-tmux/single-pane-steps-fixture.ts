// ---------------------------------------------------------------------------
// single-pane-steps-fixture (S2) — a real tmux server running ONLY the steps
// pane (parent D4). Net-new infrastructure: it boots one pane whose command is
// the `single-pane-steps-entry` Ink child, fed a synthetic live state. The
// `screen` driver wraps this to assert left-pane bytes off real tmux without
// the full two-pane host.
//
// Socket allocation, server reaping, and teardown all reuse `createRealTmuxFixture`
// — the predictability substrate is shared, not reimplemented. `resize(w,h)`
// re-creates the single-pane session at the new geometry (the entry is stateless
// — it renders the same synthetic state — so re-launch is the cleanest re-render).

import { join } from 'node:path'
import type { PaneId } from '../../../src/services/tmux/index.ts'
import { createRealTmuxFixture, type RealTmuxFixture } from './fixture.ts'
import { type NamedKey, sendKeysToPane } from './keys.ts'
import { createPaneHandle, type PaneHandle } from './pane-handle.ts'
import type { SinglePaneStepsSpec } from './synthetic-steps-state.ts'

const SESSION = 'screen'
const ENTRY = join(import.meta.dir, 'single-pane-steps-entry.tsx')

export interface SinglePaneStepsFixture {
  /** Handle for capturing the single steps pane's bytes. */
  readonly leftPane: PaneHandle
  /** Boot (or re-boot) the steps pane rendering `spec`. */
  launch(spec: SinglePaneStepsSpec): Promise<void>
  /** Re-render the steps pane at a new geometry. */
  resize(width: number, height: number): Promise<void>
  /**
   * Dispatch a single keystroke (named key like `Up`/`Enter`, or literal text)
   * to the steps pane — the navigation transport the real-tmux pane driver uses
   * to drive `selectStep`/`followLive` over real tmux (parent U4, K1/K2).
   */
  sendKey(input: NamedKey | string): Promise<void>
  /** Kill the tmux server + remove the state base. Idempotent. */
  dispose(): Promise<void>
}

export interface CreateSinglePaneStepsFixtureOptions {
  readonly width?: number
  readonly height?: number
}

export async function createSinglePaneStepsFixture(
  opts: CreateSinglePaneStepsFixtureOptions = {},
): Promise<SinglePaneStepsFixture> {
  const fixture: RealTmuxFixture = await createRealTmuxFixture({
    env: {},
    ...(opts.width !== undefined ? { width: opts.width } : {}),
    ...(opts.height !== undefined ? { height: opts.height } : {}),
  })

  let width = fixture.width
  let height = fixture.height
  let paneId: PaneId | undefined
  let spec: SinglePaneStepsSpec | undefined

  const command = (s: SinglePaneStepsSpec): readonly string[] => {
    const b64 = Buffer.from(JSON.stringify(s), 'utf8').toString('base64')
    return [process.execPath, ENTRY, '--spec', b64]
  }

  const recreateSession = async (s: SinglePaneStepsSpec): Promise<void> => {
    // Best-effort kill of any prior session (a re-launch / resize). On the first
    // launch the server does not exist yet, so `killSession` throws "error
    // connecting" — swallow it; `createSession` boots the server fresh.
    await fixture.tmux.killSession({ socket: fixture.socket, session: SESSION }).catch(() => {})
    const result = await fixture.tmux.createSession({
      socket: fixture.socket,
      session: SESSION,
      width,
      height,
      command: command(s),
    })
    paneId = result.paneId
  }

  const leftPane = createPaneHandle({
    tmux: fixture.tmux,
    socket: fixture.socket,
    resolvePaneId: async (): Promise<PaneId> => {
      if (paneId === undefined) {
        throw new Error('single-pane-steps-fixture: launch(spec) must run before any capture')
      }
      return paneId
    },
    label: 'steps',
  })

  return {
    leftPane,
    async launch(s: SinglePaneStepsSpec): Promise<void> {
      spec = s
      await recreateSession(s)
    },
    async resize(w: number, h: number): Promise<void> {
      width = w
      height = h
      if (spec !== undefined) await recreateSession(spec)
    },
    async sendKey(input: NamedKey | string): Promise<void> {
      if (paneId === undefined) {
        throw new Error('single-pane-steps-fixture: launch(spec) must run before sendKey')
      }
      await sendKeysToPane({ tmux: fixture.tmux, socket: fixture.socket, target: paneId }, input)
    },
    dispose: () => fixture.dispose(),
  }
}
