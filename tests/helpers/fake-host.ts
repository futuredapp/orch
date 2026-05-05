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
import type {
  CommandLine,
  Host,
  InteractiveResult,
  InteractiveSpawn,
  PaneAttachment,
  PaneRole,
} from '../../src/hosts/index.ts'
import type { RunnerEvent, TranscriptLine } from '../../src/runners/index.ts'

export interface RecordedRunnerEvent {
  readonly kind: 'runner'
  readonly step: StepName
  readonly event: RunnerEvent
  readonly lines: readonly TranscriptLine[]
}

export interface RecordedLifecycleEvent {
  readonly kind: 'lifecycle'
  readonly event: StepLifecycleEvent
}

export interface RecordedCommandLineEvent {
  readonly kind: 'command-line'
  readonly spec: CommandLine
}

export type RecordedHostEvent =
  | RecordedRunnerEvent
  | RecordedLifecycleEvent
  | RecordedCommandLineEvent

export interface FakeHostOptions {
  readonly mode?: RunMode
}

export interface RecordedInteractiveSpawn {
  readonly argv: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly stepName: StepName
}

export interface FakeHost extends Host {
  readonly recorded: readonly RecordedHostEvent[]
  readonly banners: readonly string[]
  readonly attachments: readonly PaneRole[]
  readonly interactiveSpawns: readonly RecordedInteractiveSpawn[]
  setInteractiveResult(result: InteractiveResult): void
}

export function createFakeHost(opts: FakeHostOptions = {}): FakeHost {
  const recorded: RecordedHostEvent[] = []
  const banners: string[] = []
  const attachments: PaneRole[] = []
  const interactiveSpawns: RecordedInteractiveSpawn[] = []
  const mode: RunMode = opts.mode ?? 'plain'
  let nextInteractive: InteractiveResult = { exitCode: 0, durationMs: 0 }

  const host: FakeHost = {
    mode,
    recorded,
    banners,
    attachments,
    interactiveSpawns,
    setInteractiveResult(result: InteractiveResult): void {
      nextInteractive = result
    },
    writeBanner(line: string): void {
      banners.push(line)
    },
    onRunnerEvent(event: RunnerEvent, step: StepName, lines: readonly TranscriptLine[]): void {
      recorded.push({ kind: 'runner', step, event, lines })
    },
    onLifecycleEvent(event: StepLifecycleEvent): void {
      recorded.push({ kind: 'lifecycle', event })
    },
    onCommandLine(spec: CommandLine): void {
      recorded.push({ kind: 'command-line', spec })
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
    async runInteractive(spawn: InteractiveSpawn): Promise<InteractiveResult> {
      interactiveSpawns.push({
        argv: spawn.argv,
        env: spawn.env,
        stepName: spawn.stepName,
      })
      return nextInteractive
    },
    async attachForeground(): Promise<void> {
      /* FakeHost never takes the TTY — executor tests race this against the
         workflow promise and get immediate resolution. */
    },
    async teardown(): Promise<void> {
      /* no-op */
    },
  }
  return host
}
