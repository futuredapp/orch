import type { StepName } from '../../core/types.ts'
import type { StepLifecycleEvent } from '../../core/workflow.ts'
import type { RunnerEvent, TranscriptLine } from '../../runners/index.ts'
import type { CommandLine, Host, PaneRole } from '../host.ts'

/**
 * Returns a composite Host that fans observability signals to both `primary`
 * and `secondary`, while delegating interface methods exclusively to `primary`.
 *
 * Secondary errors in fanned methods are swallowed — a secondary implementation
 * bug must never surface as a primary host error.
 */
export function createCompositeHost(primary: Host, secondary: Host): Host {
  const fanSafe = (fn: () => void): void => {
    try {
      fn()
    } catch {
      // swallowed: secondary errors must not propagate
    }
  }

  return {
    get mode() {
      return primary.mode
    },

    writeBanner(line: string): void {
      primary.writeBanner(line)
      fanSafe(() => secondary.writeBanner(line))
    },

    onRunnerEvent(event: RunnerEvent, step: StepName, lines: readonly TranscriptLine[]): void {
      primary.onRunnerEvent(event, step, lines)
      fanSafe(() => secondary.onRunnerEvent(event, step, lines))
    },

    onLifecycleEvent(event: StepLifecycleEvent): void {
      primary.onLifecycleEvent(event)
      fanSafe(() => secondary.onLifecycleEvent(event))
    },

    onCommandLine(spec: CommandLine): void {
      primary.onCommandLine(spec)
      fanSafe(() => secondary.onCommandLine(spec))
    },

    attach(pane: PaneRole) {
      return primary.attach(pane)
    },

    runInteractive(opts) {
      return primary.runInteractive(opts)
    },

    attachForeground() {
      return primary.attachForeground()
    },

    awaitForegroundShutdown() {
      return primary.awaitForegroundShutdown()
    },

    probeReachability() {
      return primary.probeReachability()
    },

    teardown() {
      return primary.teardown()
    },
  }
}
