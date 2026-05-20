/**
 * Public DSL user actions. Each constructor returns a `UserAction` token;
 * `userAction(token)` executes it against the implicit "current" `OrchHandle`
 * (the one returned by the most recent `launchOrchWorkflow`).
 *
 * U1 declares the constructors as stubs; U4 implements `release` /
 * `signalOrch`, U7 adds `signalOrch` to the full set, U8 adds
 * `clickOnPane` / `pressKeyInPane` / `typeInAttachTty`, U10 adds
 * `closeStdin`.
 */

import type { ExternalTmuxProbe } from './internal/external-tmux-probe.ts'
import type { OrchHandle } from './internal/lifecycle-handle.ts'

/**
 * A user action is a closure that performs one gesture against the orch
 * subprocess and/or external tmux probe. Closures are required (not data
 * objects) so the gesture can compose multiple subprocess calls (e.g.
 * `clickOnPane` resolves pane geometry, then dispatches press + release).
 */
export type UserAction = (handle: OrchHandle, probe: ExternalTmuxProbe) => Promise<void>

export const userAction = async (_action: UserAction): Promise<void> => {
  throw new Error('userAction not yet implemented — lands in U4')
}

// ─── Action constructors ───────────────────────────────────────────────────
// All bodies throw until their owner unit fills them in.

export const signalOrch = (_signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP'): UserAction => {
  throw new Error('signalOrch not yet implemented — lands in U7')
}

export const clickOnPane = (_pane: 'left' | 'right'): UserAction => {
  throw new Error('clickOnPane not yet implemented — lands in U8')
}

export const pressKeyInPane = (_pane: 'left' | 'right', _key: string): UserAction => {
  throw new Error('pressKeyInPane not yet implemented — lands in U8')
}

export const typeInAttachTty = (_bytes: string | Uint8Array): UserAction => {
  throw new Error('typeInAttachTty not yet implemented — lands in U8')
}

export const wait = (_ms: number): UserAction => {
  throw new Error('wait not yet implemented — lands in U8')
}

export const release = (_stepName: string): UserAction => {
  throw new Error('release not yet implemented — lands in U4')
}

export const closeStdin = (): UserAction => {
  throw new Error('closeStdin not yet implemented — lands in U10')
}
