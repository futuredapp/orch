// ---------------------------------------------------------------------------
// projectStepsView — pure projector: state.json + overlay → StepsViewState.
// ---------------------------------------------------------------------------
//
// No I/O, no React. The composing factory in `steps-view-model.ts` calls this
// every time the underlying state.json or lifecycle.ndjson changes.
//
// Sub-workflow boundary rows (`▼` enter / `✓` / `✗` exit) live ONLY here in the
// projected state — they are never persisted. The projector derives them from
// `StepEntry.subPath` transitions across persisted steps, with the live
// `subOverlay` filling in in-flight stepless subs and providing `durationMs`
// for completed exits before they're persisted.

import type { RunState, StepEntry } from '../../../state/index.ts'
import { type LiveOverlay, type SubworkflowOverlay, subworkflowOverlayKey } from './live-overlay.ts'
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
  /**
   * Per-sub overlay derived from `subworkflow:enter` / `subworkflow:exit`
   * events. Optional so callers that don't tail lifecycle events (older
   * tests, direct invocations) keep working — absent ⇔ empty map.
   */
  readonly subOverlay?: ReadonlyMap<string, SubworkflowOverlay>
  readonly workflowName: string
  readonly runIdFallback: string
  /** Persistent footer indicator. Default `{mode:'live'}` when omitted. */
  readonly view?: ViewMode
  /** Optional transient banner. Default omitted. */
  readonly banner?: Banner
}

const DEFAULT_VIEW: ViewMode = { mode: 'live' }
const EMPTY_SUB_OVERLAY: ReadonlyMap<string, SubworkflowOverlay> = new Map()

export function projectStepsView(args: ProjectArgs): StepsViewState {
  const run = args.run
  const subOverlay = args.subOverlay ?? EMPTY_SUB_OVERLAY
  const records = collectRecords(run, args.overlay)
  const suppressed = collectSuppressedSubs(records, subOverlay)
  const runStatus = run?.status ?? 'running'

  const steps = buildRows({
    records,
    subOverlay,
    suppressed,
    terminal: runStatus !== 'running',
  })

  const header: RunHeader = {
    runId: run?.id ?? args.runIdFallback,
    workflowName: args.workflowName,
    startedAt: run?.startedAt ?? 0,
  }
  const view = args.view ?? DEFAULT_VIEW
  const bannerSlot = args.banner !== undefined ? { banner: args.banner } : {}
  return finalizeView({ runStatus, run, header, steps, view, bannerSlot })
}

// ---------------------------------------------------------------------------
// Record assembly — flatten persisted + overlay-only steps into one ordered
// list. Insertion order on `run.steps` reflects chronological order; overlay-
// only steps (running with no persisted entry yet) tail after persisted ones.
// ---------------------------------------------------------------------------

interface StepRecord {
  readonly name: string
  readonly entry: StepEntry | undefined
  readonly live: LiveOverlay | undefined
  readonly subPath: readonly string[]
  readonly insideParallel: boolean
}

function collectRecords(
  run: RunState | undefined,
  overlay: ReadonlyMap<string, LiveOverlay>,
): readonly StepRecord[] {
  const seen = new Set<string>()
  const records: StepRecord[] = []
  const persisted = run?.steps ?? {}
  for (const name of Object.keys(persisted)) {
    if (seen.has(name)) continue
    seen.add(name)
    const entry = persisted[name]
    if (entry === undefined) continue
    records.push({
      name,
      entry,
      live: overlay.get(name),
      subPath: entry.subPath ?? [],
      insideParallel: entry.insideParallel === true,
    })
  }
  for (const [name, live] of overlay) {
    if (seen.has(name)) continue
    seen.add(name)
    records.push({
      name,
      entry: undefined,
      live,
      subPath: live.subPath ?? [],
      insideParallel: live.insideParallel === true,
    })
  }
  return records
}

// ---------------------------------------------------------------------------
// R23 parallel suppression — a sub is suppressed iff any step under it has
// `insideParallel: true`, OR its own subOverlay entry carries the flag.
// Suppression is uniform across the whole subtree (the propagation comes from
// `parallel()`'s branchStore setting `insideParallel: true` for every step
// inside a parallel branch, transitively into nested subs).
// ---------------------------------------------------------------------------

function collectSuppressedSubs(
  records: readonly StepRecord[],
  subOverlay: ReadonlyMap<string, SubworkflowOverlay>,
): ReadonlySet<string> {
  const suppressed = new Set<string>()
  for (const rec of records) {
    if (!rec.insideParallel) continue
    for (let i = 0; i < rec.subPath.length; i++) {
      suppressed.add(subworkflowOverlayKey(rec.subPath.slice(0, i + 1)))
    }
  }
  for (const sub of subOverlay.values()) {
    if (sub.insideParallel !== true) continue
    for (let i = 0; i < sub.subPath.length; i++) {
      suppressed.add(subworkflowOverlayKey(sub.subPath.slice(0, i + 1)))
    }
  }
  return suppressed
}

// ---------------------------------------------------------------------------
// Row emission — walk records emitting boundary rows on subPath transitions
// and step rows for each record; finalize trailing open subs at end.
// ---------------------------------------------------------------------------

interface BuildRowsArgs {
  readonly records: readonly StepRecord[]
  readonly subOverlay: ReadonlyMap<string, SubworkflowOverlay>
  readonly suppressed: ReadonlySet<string>
  readonly terminal: boolean
}

function buildRows(args: BuildRowsArgs): StepRow[] {
  const rows: StepRow[] = []
  const renderedSubs = new Set<string>()
  let currentPath: readonly string[] = []

  for (const rec of args.records) {
    const newPath = rec.subPath
    const k = commonPrefixLength(currentPath, newPath)

    // Close subs we are leaving (deepest first).
    for (let i = currentPath.length - 1; i >= k; i--) {
      const name = currentPath[i]
      if (name === undefined) continue
      const subPath = currentPath.slice(0, i + 1)
      const exit = buildExitRow(name, i + 1, subPath, args.subOverlay, args.suppressed)
      if (exit !== undefined) rows.push(exit)
    }

    // Open subs we are entering (shallowest first).
    for (let i = k; i < newPath.length; i++) {
      const name = newPath[i]
      if (name === undefined) continue
      const subPath = newPath.slice(0, i + 1)
      const key = subworkflowOverlayKey(subPath)
      if (renderedSubs.has(key)) continue
      const enter = buildEnterRow(name, i + 1, subPath, args.suppressed)
      if (enter !== undefined) rows.push(enter)
      renderedSubs.add(key)
    }

    rows.push(buildStepRow(rec))
    currentPath = newPath
  }

  // Close any subs still open at the tail. While the run is live, only close
  // subs that the overlay has marked terminal — others stay "in-flight" and
  // their `▼` row remains visible without a matching exit. At terminal status
  // every open sub gets a closing row (using the overlay's status when
  // available, otherwise a synthesized `✗` with no `durationMs`).
  for (let i = currentPath.length - 1; i >= 0; i--) {
    const name = currentPath[i]
    if (name === undefined) continue
    const subPath = currentPath.slice(0, i + 1)
    const sub = getSubOverlay(args.subOverlay, subPath)
    if (!args.terminal && sub?.status === 'running') continue
    const exit = buildExitRow(name, i + 1, subPath, args.subOverlay, args.suppressed)
    if (exit !== undefined) rows.push(exit)
  }

  // In-flight stepless subs: any sub in the overlay we haven't rendered yet
  // (no child step ever materialised). Append in `startedAt` order so the
  // tail reflects chronology.
  const stepless: readonly [string, SubworkflowOverlay][] = [...args.subOverlay]
    .filter(([key]) => !renderedSubs.has(key))
    .sort((a, b) => a[1].startedAt - b[1].startedAt)
  for (const [key, sub] of stepless) {
    const name = sub.subPath[sub.subPath.length - 1]
    if (name === undefined) continue
    const enter = buildEnterRow(name, sub.depth, sub.subPath, args.suppressed)
    if (enter !== undefined) rows.push(enter)
    renderedSubs.add(key)
    if (sub.status !== 'running' || args.terminal) {
      const exit = buildExitRow(name, sub.depth, sub.subPath, args.subOverlay, args.suppressed)
      if (exit !== undefined) rows.push(exit)
    }
  }

  return rows
}

function commonPrefixLength(a: readonly string[], b: readonly string[]): number {
  const max = Math.min(a.length, b.length)
  let i = 0
  while (i < max && a[i] === b[i]) i++
  return i
}

function buildEnterRow(
  name: string,
  depth: number,
  subPath: readonly string[],
  suppressed: ReadonlySet<string>,
): StepRow | undefined {
  if (suppressed.has(subworkflowOverlayKey(subPath))) return undefined
  return { kind: 'subworkflow-enter', name, depth, subPath, glyph: '▼' }
}

function buildExitRow(
  name: string,
  depth: number,
  subPath: readonly string[],
  subOverlay: ReadonlyMap<string, SubworkflowOverlay>,
  suppressed: ReadonlySet<string>,
): StepRow | undefined {
  if (suppressed.has(subworkflowOverlayKey(subPath))) return undefined
  const sub = getSubOverlay(subOverlay, subPath)
  const glyph: '✓' | '✗' = sub?.status === 'completed' ? '✓' : '✗'
  return {
    kind: 'subworkflow-exit',
    name,
    depth,
    subPath,
    glyph,
    durationMs: sub?.durationMs,
  }
}

function getSubOverlay(
  subOverlay: ReadonlyMap<string, SubworkflowOverlay>,
  subPath: readonly string[],
): SubworkflowOverlay | undefined {
  return subOverlay.get(subworkflowOverlayKey(subPath))
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

// ---------------------------------------------------------------------------
// Step-row construction
// ---------------------------------------------------------------------------

function buildStepRow(rec: StepRecord): StepRow {
  const entry = rec.entry
  const live = rec.live
  const status: StepStatus = live?.status ?? 'completed'
  const startedAt = live?.startedAt ?? entry?.startedAt
  const endedAt = live?.endedAt ?? entry?.endedAt
  // R23: a step inside a parallel branch renders flat (no sub gutter) even
  // when its subPath is non-empty — the parallel rollup is the visual frame
  // for these rows, not the sub gutter.
  const depth = rec.insideParallel ? 0 : rec.subPath.length
  const base: RowBase = {
    name: rec.name,
    status,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(depth > 0 ? { depth } : {}),
  }
  const value = entry?.value
  if (rec.name.startsWith('commit:')) return { kind: 'commit', value, ...base }
  if (rec.name.startsWith('worktree:')) return { kind: 'worktree', value, ...base }
  if (rec.name.startsWith('ask:')) return { kind: 'ask', value, ...base }
  if (rec.name.startsWith('command:')) return { kind: 'command', ...base }
  const mode = live?.mode ?? entry?.mode ?? 'autonomous'
  return buildAgentRow({
    base,
    mode,
    sessionId: entry?.sessionId,
    transcriptPath: entry?.transcriptPath,
    resumeHints: {
      runnerName: entry?.runnerName,
      sessionIdCaptureError: entry?.sessionIdCaptureError,
    },
  })
}

interface RowBase {
  readonly name: string
  readonly status: StepStatus
  readonly startedAt?: number
  readonly endedAt?: number
  readonly depth?: number
}

interface AgentRowArgs {
  readonly base: RowBase
  readonly mode: 'interactive' | 'autonomous'
  readonly sessionId: string | undefined
  readonly transcriptPath: string | undefined
  readonly resumeHints: {
    readonly runnerName?: string
    readonly sessionIdCaptureError?: 'ambiguous' | 'empty' | 'error'
  }
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
      ...(resumeHints.runnerName !== undefined ? { runnerName: resumeHints.runnerName } : {}),
      ...(resumeHints.sessionIdCaptureError !== undefined
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

type SelectableRow = Exclude<StepRow, { kind: 'subworkflow-enter' | 'subworkflow-exit' }>

function isStepRow(s: StepRow): s is SelectableRow {
  return s.kind !== 'subworkflow-enter' && s.kind !== 'subworkflow-exit'
}

function summarize(run: RunState | undefined, steps: readonly StepRow[]): EndOfRunSummary {
  const startedAt = run?.startedAt ?? 0
  const endedAt = run?.endedAt ?? startedAt
  // Boundary rows are excluded from totals — they're not persisted "steps".
  const stepRows = steps.filter(isStepRow)
  const completed = stepRows.filter((s) => s.status === 'completed').length
  const failed = stepRows.filter((s) => s.status === 'failed').length
  return {
    endedAt,
    durationMs: Math.max(0, endedAt - startedAt),
    stepsTotal: stepRows.length,
    stepsCompleted: completed,
    stepsFailed: failed,
  }
}
