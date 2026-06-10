// ---------------------------------------------------------------------------
// NullHost — a Host that discards everything.
// ---------------------------------------------------------------------------
//
// Used by the cold-open registry rehydration (`rehydrateResumeRegistry`): the
// executor's `populateResumeRegistry` replay needs a `Host` to satisfy
// `WorkflowDeps`, but that replay registers interactive runners from the cache
// and aborts before any real step runs — so no lifecycle/runner event ever
// carries meaningful information. Routing those no-op events into the real
// two-pane host would leak `step:cached` chatter into the read-only viewer and
// could touch the "no steps execute" guarantee; a NullHost makes the replay
// invisible. It owns no backing surface, so every method is a no-op.

import type { RunMode } from '../core/run-mode.ts'
import type { Host, HostReachability, InteractiveResult, PaneAttachment, PaneRole } from './host.ts'

/**
 * A Host whose every method is a no-op. `mode` defaults to `'two-pane'` so the
 * replay sees the same RunMode a real cold open would, though the
 * registry-population pass never reaches a code path that reads it.
 */
export function createNullHost(mode: RunMode = 'two-pane'): Host {
  return {
    mode,
    writeBanner(): void {},
    onRunnerEvent(): void {},
    onLifecycleEvent(): void {},
    onCommandLine(): void {},
    async attach(pane: PaneRole): Promise<PaneAttachment> {
      return {
        pane,
        async detach(): Promise<void> {},
      }
    },
    async runInteractive(): Promise<InteractiveResult> {
      // The replay aborts before any interactive step executes, so this is
      // never invoked; returning a benign result keeps the contract total.
      return { exitCode: 0, durationMs: 0 }
    },
    async attachForeground(): Promise<void> {},
    async awaitForegroundShutdown(): Promise<'quit' | 'attach-exited'> {
      return 'attach-exited'
    },
    async probeReachability(): Promise<HostReachability> {
      return { reachable: true }
    },
    async teardown(): Promise<void> {},
  }
}
