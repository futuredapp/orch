// ---------------------------------------------------------------------------
// FakeHost — test-only Host that captures events instead of printing them.
// ---------------------------------------------------------------------------
//
// Tests that drive `workflow.execute(...)` directly no longer care about the
// stdout shape; they want to assert the sequence of lifecycle/runner events
// the executor emitted. `FakeHost` records them in arrival order so tests
// stay focused on behaviour instead of string formatting.
//
// Lives under `tests/helpers/` because it's a test port, not a production
// host. The executor only depends on the `Host` interface, which is how
// FakeHost plugs in without violating CLAUDE.md rule #3 (mock at the seam).

import type { RunMode } from '../../src/core/run-mode.ts'
import type { StepName } from '../../src/core/types.ts'
import type { StepLifecycleEvent } from '../../src/core/workflow.ts'
import type { Host, PaneAttachment, PaneRole } from '../../src/hosts/index.ts'
import type { RunnerEvent } from '../../src/runners/index.ts'

export interface RecordedRunnerEvent {
  readonly kind: 'runner'
  readonly step: StepName
  readonly event: RunnerEvent
}

export interface RecordedLifecycleEvent {
  readonly kind: 'lifecycle'
  readonly event: StepLifecycleEvent
}

export type RecordedHostEvent = RecordedRunnerEvent | RecordedLifecycleEvent

export interface FakeHostOptions {
  readonly mode?: RunMode
}

export interface FakeHost extends Host {
  readonly recorded: readonly RecordedHostEvent[]
  readonly banners: readonly string[]
  readonly attachments: readonly PaneRole[]
}

export function createFakeHost(opts: FakeHostOptions = {}): FakeHost {
  const recorded: RecordedHostEvent[] = []
  const banners: string[] = []
  const attachments: PaneRole[] = []
  const mode: RunMode = opts.mode ?? 'plain'

  const host: FakeHost = {
    mode,
    recorded,
    banners,
    attachments,
    writeBanner(line: string): void {
      banners.push(line)
    },
    onRunnerEvent(event: RunnerEvent, step: StepName): void {
      recorded.push({ kind: 'runner', step, event })
    },
    onLifecycleEvent(event: StepLifecycleEvent): void {
      recorded.push({ kind: 'lifecycle', event })
    },
    async attach(pane: PaneRole): Promise<PaneAttachment> {
      attachments.push(pane)
      return {
        pane,
        async detach(): Promise<void> {
          /* no-op */
        },
      }
    },
    async teardown(): Promise<void> {
      /* no-op */
    },
  }
  return host
}
