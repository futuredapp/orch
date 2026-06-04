/**
 * `ScriptedFakeRunner` — sibling of `FakeRunner` for Tier 5 lifecycle tests.
 *
 * Where `FakeRunner` drives its script from an in-process method chain (the
 * test author shares a process with the workflow), `ScriptedFakeRunner` is
 * spawned by orch in a CHILD process; the script must cross the process
 * boundary. Each step's behavior is pulled from a JSON file pointed to by
 * `ORCH_LIFECYCLE_SCRIPT` and indexed by `ORCH_LIFECYCLE_STEP_NAME`.
 *
 * The runner factory takes the step name at construction time (one runner
 * per workflow step). `buildCommand` emits an argv that re-invokes
 * `__entry.ts` under bun; the entry process reads the script, dispatches on
 * `StepScript.kind`, and writes scripted events to stdout.
 *
 * Production builds never instantiate this runner — only fixture workflows
 * under `tests/fixtures/lifecycle/` do.
 */

import * as nodePath from 'node:path'
import { mergeEnv } from '../../services/process/index.ts'
import {
  defineRunner,
  type RunnerCommand,
  type RunnerContext,
  type RunnerEvent,
  type TerminalEvent,
  type TranscriptLine,
} from '../types.ts'

export interface ScriptedFakeOptions {
  /**
   * Step name binding. `buildCommand` exports this as the
   * `ORCH_LIFECYCLE_STEP_NAME` env var so the entry process can look up the
   * matching `StepScript` from the JSON file.
   *
   * Fixture workflows construct one runner per step:
   *   const plan    = scriptedFake({ stepName: 'plan' })
   *   const execute = scriptedFake({ stepName: 'execute' })
   */
  readonly stepName: string
  /**
   * Interactive (TUI) mode (U4). When `true`, `supports.interactive` is `true`
   * and `buildCommand` re-invokes `interactive-entry.ts` (a real-PTY TTY reader)
   * instead of the headless `__entry.ts`.
   *
   * Construction-time, NOT a runtime conditional: `supports` is frozen at
   * `defineRunner` time and the executor gates on
   * `config.agent.supports.interactive` with no mode argument available, so one
   * runner object cannot report `true` for an interactive step and `false` for
   * an autonomous one. Harness fixtures build one runner per step, so an
   * interactive step constructs an interactive runner and an autonomous step
   * keeps `interactive: false`. Defaults to `false`.
   */
  readonly interactive?: boolean
  /**
   * Interactive pane UI. Only consulted when `interactive` is `true`:
   *   - `'raw'` (default) — the deterministic line-printer (`interactive-entry.ts`).
   *     Shows nothing until Enter; used by the test harness and the non-TTY
   *     integration test (which pipes stdin, so it cannot use Ink raw-mode input).
   *   - `'ink'` — the Ink list+input TUI (`ink-entry.tsx`). Echoes keystrokes as
   *     you type; for human/dev driving in a real PTY pane.
   *
   * Both share one engine, sink contract, and the `.ready`/`.ack`/render-log
   * signals, so a driver cannot tell which is mounted.
   */
  readonly interactiveUi?: 'raw' | 'ink'
}

/**
 * Resolves the absolute filesystem path to an entry script. `import.meta.dir`
 * points at this file's directory regardless of cwd, so the resolved path is
 * stable across spawn cwds (the orch subprocess's cwd is the fixture dir).
 */
function entryScriptPath(file: string): string {
  return nodePath.join(import.meta.dir, file)
}

export function scriptedFake(opts: ScriptedFakeOptions) {
  const { stepName } = opts
  if (stepName.length === 0) {
    throw new Error('scriptedFake({ stepName }): stepName cannot be empty')
  }
  const interactive = opts.interactive ?? false
  const interactiveEntry =
    (opts.interactiveUi ?? 'raw') === 'ink' ? 'ink-entry.tsx' : 'interactive-entry.ts'
  const entry = entryScriptPath(interactive ? interactiveEntry : '__entry.ts')

  return defineRunner({
    name: 'scripted-fake',
    supports: { interactive, structuredOutput: true },
    defaultView: { kind: 'transcript', pane: 'right' },

    buildCommand(ctx: RunnerContext): RunnerCommand {
      return {
        argv: ['bun', entry],
        // Three-layer mergeEnv (passthrough policy):
        //   1. process.env carries ORCH_LIFECYCLE_SCRIPT (set by the test
        //      launcher on the orch subprocess and inherited into ours).
        //   2. extras pins the step-name binding for THIS spawn.
        //   3. ctx.env (workflow-author overrides) wins last.
        env: mergeEnv(process.env, { ORCH_LIFECYCLE_STEP_NAME: stepName }, ctx.env),
      }
    },

    parseEvents(line: string): RunnerEvent | null {
      if (line.trim() === '') return null
      try {
        return JSON.parse(line) as RunnerEvent
      } catch {
        return null
      }
    },

    extractStructuredOutput(finalEvent: TerminalEvent): unknown {
      if (finalEvent.type === 'error') return undefined
      return (finalEvent as { data?: unknown }).data
    },

    toTranscriptLines(event: RunnerEvent): readonly TranscriptLine[] {
      if (event.kind === 'terminal' && event.type === 'error') {
        return [{ kind: 'block', heading: 'failed', rows: [['error', event.message]] }]
      }
      if (event.kind === 'info') {
        const payload = event.payload as { readonly text?: unknown } | undefined
        if (payload !== undefined && typeof payload.text === 'string' && payload.text.length > 0) {
          return [{ kind: 'line', category: 'assistant', label: 'assistant>', body: payload.text }]
        }
      }
      return []
    },
  })
}
