// ---------------------------------------------------------------------------
// PaneQueue — per-pane serial promise chain.
// ---------------------------------------------------------------------------
//
// Why: the old fire-and-forget `void tmux.sendKeys(...).catch(...)` pattern in
// `tmux-wiring.ts:158` let a transcript line race `respawn-pane -k`. If the
// runner swap won, the pending keystrokes landed on the replacement process's
// stdin — Claude would literally receive `▸ tool: write_file(…)` as typed
// input. Serializing every write through a per-pane chain closes that race.
//
// All per-pane operations (sendKeys, respawnPane, any future tmux command that
// targets a pane) must go through `enqueue(paneId, op)`. The chain preserves
// order: op N+1 waits for op N to settle before it runs, even if N rejects.
// A rejection does not abort the chain — downstream ops still fire, and the
// rejection is re-thrown to the caller of that specific `enqueue` call.

import type { PaneId } from '../../services/tmux/index.ts'

export interface PaneQueue {
  /**
   * Append `op` to the tail of `pane`'s serial chain. Returns a promise that
   * resolves/rejects with op's own outcome. Later ops wait for this one to
   * settle (success or failure) before running.
   */
  enqueue<T>(pane: PaneId, op: () => Promise<T>): Promise<T>
  /** Wait for every pending op across every pane. Used by teardown paths. */
  drain(): Promise<void>
}

export function createPaneQueue(): PaneQueue {
  const chains = new Map<PaneId, Promise<unknown>>()

  const enqueue = <T>(pane: PaneId, op: () => Promise<T>): Promise<T> => {
    const prev = chains.get(pane) ?? Promise.resolve()
    // `.catch(() => {})` isolates the chain from predecessor rejections —
    // otherwise one failure would poison every later op on the same pane.
    const next = prev.catch(() => undefined).then(op)
    chains.set(pane, next)
    return next
  }

  const drain = async (): Promise<void> => {
    // Snapshot current chains; settle them all. New enqueues during drain are
    // the caller's responsibility.
    const pending = [...chains.values()]
    await Promise.allSettled(pending)
  }

  return { enqueue, drain }
}
