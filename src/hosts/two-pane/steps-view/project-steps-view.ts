// ---------------------------------------------------------------------------
// projectStepsView — pure projector: state.json + overlay → StepsViewState.
// ---------------------------------------------------------------------------
//
// No I/O, no React. The composing factory in `steps-view-model.ts` calls this
// every time the underlying state.json or lifecycle.ndjson changes.

import type { RunState } from '../../../state/index.ts'
import type { LiveOverlay } from './live-overlay.ts'
import type {
  Banner,
  EndOfRunSummary,
  RunHeader,
  StepRow,
  StepStatus,
  StepsViewState,
  ViewMode,
} from './step-types.ts'

export interface ProjectArgs {
  readonly run: RunState | undefined
  readonly overlay: ReadonlyMap<string, LiveOverlay>
  readonly workflowName: string
  readonly runIdFallback: string
  /** Persistent footer indicator. Default `{mode:'live'}` when omitted. */
  readonly view?: ViewMode
  /** Optional transient banner. Default omitted. */
  readonly banner?: Banner
}

const DEFAULT_VIEW: ViewMode = { mode: 'live' }

export function projectStepsView(args: ProjectArgs): StepsViewState {
  const run = args.run
  const stepNames = new Set<string>()
  const steps: StepRow[] = []
  const persisted = run?.steps ?? {}

  for (const name of Object.keys(persisted)) {
    if (stepNames.has(name)) continue
    stepNames.add(name)
    const entry = persisted[name]
    if (entry === undefined) continue
    const live = args.overlay.get(name)
    steps.push(
      buildRow(name, entry.value, entry.mode, entry.transcriptPath, entry.sessionId, live, entry, {
        runnerName: entry.runnerName,
        sessionIdCaptureError: entry.sessionIdCaptureError,
      }),
    )
  }
  for (const [name, live] of args.overlay) {
    if (stepNames.has(name)) continue
    stepNames.add(name)
    steps.push(
      buildRow(name, undefined, live.mode, undefined, undefined, live, undefined, undefined),
    )
  }

  const header: RunHeader = {
    runId: run?.id ?? args.runIdFallback,
    workflowName: args.workflowName,
    startedAt: run?.startedAt ?? 0,
  }
  const view = args.view ?? DEFAULT_VIEW
  const bannerSlot = args.banner !== undefined ? { banner: args.banner } : {}
  const runStatus = run?.status ?? 'running'
  return finalizeView({ runStatus, run, header, steps, view, bannerSlot })
}

interface FinalizeArgs {
  readonly runStatus: RunState['status']
  readonly run: RunState | undefined
  readonly header: RunHeader
  readonly steps: StepRow[]
  readonly view: ViewMode
  readonly bannerSlot: { readonly banner?: Banner }
}

// Maps the resolved run status to the terminal StepsViewState shape. Extracted
// from projectStepsView to keep that function under the rule-5 budget; running
// runs skip the summarize() pass.
function finalizeView(args: FinalizeArgs): StepsViewState {
  const { runStatus, run, header, steps, view, bannerSlot } = args
  if (runStatus === 'running') {
    return { status: 'live', run: header, steps, view, ...bannerSlot }
  }

  const summary = summarize(run, steps)
  if (runStatus === 'crashed') {
    return { status: 'crashed', run: header, steps, summary, view, ...bannerSlot }
  }
  if (summary.stepsFailed > 0) {
    return { status: 'failed', run: header, steps, summary, view, ...bannerSlot }
  }
  return { status: 'completed', run: header, steps, summary, view, ...bannerSlot }
}

interface PersistedHints {
  readonly startedAt?: number
  readonly endedAt?: number
}

function buildRow(
  name: string,
  value: unknown,
  persistedMode: 'interactive' | 'autonomous' | undefined,
  transcriptPath: string | undefined,
  sessionId: string | undefined,
  live: LiveOverlay | undefined,
  persisted: PersistedHints | undefined,
  resumeHints:
    | {
        readonly runnerName?: string
        readonly sessionIdCaptureError?: 'ambiguous' | 'empty' | 'error'
      }
    | undefined,
): StepRow {
  const status: StepStatus = live?.status ?? 'completed'
  const startedAt = live?.startedAt ?? persisted?.startedAt
  const endedAt = live?.endedAt ?? persisted?.endedAt
  const base: RowBase = {
    name,
    status,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
  }
  if (name.startsWith('commit:')) return { kind: 'commit', value, ...base }
  if (name.startsWith('worktree:')) return { kind: 'worktree', value, ...base }
  if (name.startsWith('ask:')) return { kind: 'ask', value, ...base }
  if (name.startsWith('command:')) return { kind: 'command', ...base }
  const mode = live?.mode ?? persistedMode ?? 'autonomous'
  return buildAgentRow({ base, mode, sessionId, transcriptPath, resumeHints })
}

interface RowBase {
  readonly name: string
  readonly status: StepStatus
  readonly startedAt?: number
  readonly endedAt?: number
}

interface AgentRowArgs {
  readonly base: RowBase
  readonly mode: 'interactive' | 'autonomous'
  readonly sessionId: string | undefined
  readonly transcriptPath: string | undefined
  readonly resumeHints:
    | {
        readonly runnerName?: string
        readonly sessionIdCaptureError?: 'ambiguous' | 'empty' | 'error'
      }
    | undefined
}

// Builds the interactive/autonomous agent row, attaching only the fields that
// are present. Extracted from buildRow to keep it under the rule-5 budget; the
// two modes carry different optional fields (resume hints vs transcript path).
function buildAgentRow(args: AgentRowArgs): StepRow {
  const { base, mode, sessionId, transcriptPath, resumeHints } = args
  if (mode === 'interactive') {
    return {
      kind: 'agent',
      mode: 'interactive',
      ...base,
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(resumeHints?.runnerName !== undefined ? { runnerName: resumeHints.runnerName } : {}),
      ...(resumeHints?.sessionIdCaptureError !== undefined
        ? { sessionIdCaptureError: resumeHints.sessionIdCaptureError }
        : {}),
    }
  }
  return {
    kind: 'agent',
    mode: 'autonomous',
    ...base,
    ...(transcriptPath !== undefined ? { transcriptPath } : {}),
  }
}

function summarize(run: RunState | undefined, steps: readonly StepRow[]): EndOfRunSummary {
  const startedAt = run?.startedAt ?? 0
  const endedAt = run?.endedAt ?? startedAt
  const completed = steps.filter((s) => s.status === 'completed').length
  const failed = steps.filter((s) => s.status === 'failed').length
  return {
    endedAt,
    durationMs: Math.max(0, endedAt - startedAt),
    stepsTotal: steps.length,
    stepsCompleted: completed,
    stepsFailed: failed,
  }
}
