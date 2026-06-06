/**
 * `LifecycleSnapshot` — the single immutable struct every Tier 5 matcher
 * projects over. Captured atomically per assertion by
 * `snapshot(handle, probe)`. All matcher semantics live here as field shapes;
 * no matcher reaches back through the harness for side-effecting state.
 *
 * Field origins: plan §6.4 / Key Technical Decisions.
 */

import { existsSync } from 'node:fs'
import * as nodePath from 'node:path'
import type { Clock } from '../../../../src/services/clock/index.ts'
import { BunClock } from '../../../../src/services/clock/index.ts'
import { BunProcessService, type ProcessService } from '../../../../src/services/process/index.ts'
import type { PaneId } from '../../../../src/services/tmux/index.ts'
import { path as toPath } from '../../../../src/services/types.ts'
import type { ExternalTmuxProbe } from './external-tmux-probe.ts'
import type { OrchHandle } from './lifecycle-handle.ts'

export type StateStatus = 'running' | 'completed' | 'cancelled' | 'failed' | 'crashed' | 'unknown'

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'unknown'

export interface OrchExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

export interface PaneSnapshot {
  readonly id: PaneId
  readonly dead: boolean
}

export interface EscapeCounts {
  readonly enters: number
  readonly exits: number
}

export interface MouseTrackingCounts {
  readonly ons: number
  readonly offs: number
}

export interface OrphanChild {
  readonly pid: number
  readonly ppid: number
  readonly command: string
}

export type PerStepFilesIntact = Readonly<Record<string, boolean>>

export interface LifecycleSnapshot {
  readonly orchAlive: boolean
  readonly orchExit: OrchExit | null

  readonly tmuxSessionExists: boolean
  readonly tmuxServerExists: boolean

  readonly panesAlive: readonly PaneSnapshot[]
  readonly leftPaneText: string
  readonly rightPaneText: string
  readonly leftPaneFocused: boolean
  readonly rightPaneFocused: boolean

  readonly stateStatus: StateStatus
  readonly stepStatuses: Readonly<Record<string, StepStatus>>
  readonly perStepFilesIntact: PerStepFilesIntact

  readonly stdoutAltScreen: EscapeCounts
  readonly stdoutMouseTracking: MouseTrackingCounts

  readonly orphanChildren: readonly OrphanChild[]

  readonly capturedAtMs: number
  readonly orchAliveDurationMs: number
}

// ───────────────────────────────────────────────────────────────────────────
// Matcher / projector types
// ───────────────────────────────────────────────────────────────────────────

export interface MatchResult {
  readonly matched: boolean
  readonly message: string
}

export type Matcher = (snapshot: LifecycleSnapshot) => MatchResult

export type PaneMatcherFactory = (pane: 'left' | 'right') => Matcher

export interface PollingBudget {
  readonly timeoutMs: number
}

// ───────────────────────────────────────────────────────────────────────────
// Exit tracking — latch the first wait() resolution and replay it forever.
// ───────────────────────────────────────────────────────────────────────────

interface ExitTracker {
  readonly state: () =>
    | { readonly alive: true }
    | { readonly alive: false; readonly exit: OrchExit }
}

const exitTrackers = new WeakMap<object, ExitTracker>()

function getExitTracker(handle: OrchHandle): ExitTracker {
  const cached = exitTrackers.get(handle as unknown as object)
  if (cached !== undefined) return cached
  let latched: { readonly alive: false; readonly exit: OrchExit } | undefined
  void handle.subprocess.wait().then((result) => {
    latched = { alive: false, exit: inferExitFromCode(result.exitCode) }
  })
  const tracker: ExitTracker = {
    state: () => latched ?? { alive: true },
  }
  exitTrackers.set(handle as unknown as object, tracker)
  return tracker
}

function inferExitFromCode(exitCode: number): OrchExit {
  if (exitCode >= 128 && exitCode < 192) {
    const signum = exitCode - 128
    const signal = signalFromNumber(signum)
    if (signal !== null) return { code: exitCode, signal }
  }
  return { code: exitCode, signal: null }
}

function signalFromNumber(n: number): NodeJS.Signals | null {
  switch (n) {
    case 1:
      return 'SIGHUP'
    case 2:
      return 'SIGINT'
    case 3:
      return 'SIGQUIT'
    case 9:
      return 'SIGKILL'
    case 15:
      return 'SIGTERM'
    default:
      return null
  }
}

// ───────────────────────────────────────────────────────────────────────────
// snapshot(handle, probe) — atomic capture
// ───────────────────────────────────────────────────────────────────────────

export interface SnapshotOptions {
  readonly clock?: Clock
  readonly processService?: ProcessService
  /** Optional pid for the orphan-children sweep. Omit to skip orphan probing. */
  readonly orchPid?: number
  readonly spawnedAtMs?: number
}

export async function snapshot(
  handle: OrchHandle,
  probe: ExternalTmuxProbe,
  opts: SnapshotOptions = {},
): Promise<LifecycleSnapshot> {
  const clock = opts.clock ?? new BunClock()
  const processService = opts.processService ?? new BunProcessService()
  const spawnedAtMs = opts.spawnedAtMs ?? clock.now()

  // tmux + filesystem + raw-byte probes run BEFORE we latch orch's exit
  // state (plan U6 consistency requirement: capture orchAlive LAST).
  const tmuxServerExists = await safeBool(probe.hasServer())
  const tmuxSessionExists = tmuxServerExists ? await safeBool(probe.hasSession()) : false

  let panesAlive: readonly PaneSnapshot[] = []
  let leftPaneText = ''
  let rightPaneText = ''
  let leftPaneFocused = false
  let rightPaneFocused = false
  if (tmuxSessionExists) {
    panesAlive = await safeListPanes(probe)
    leftPaneText = await safeCapture(probe, 'left')
    rightPaneText = await safeCapture(probe, 'right')
    leftPaneFocused = await safeFocused(probe, 'left')
    rightPaneFocused = await safeFocused(probe, 'right')
  }

  const { stateStatus, stepStatuses } = await readStateJson(handle)
  const perStepFilesIntact = await checkPerStepFiles(handle, stepStatuses)

  const stdoutBytes = handle.subprocess.stdoutBytes?.() ?? Buffer.alloc(0)
  const stdoutAltScreen = countAltScreen(stdoutBytes)
  const stdoutMouseTracking = countMouseTracking(stdoutBytes)

  const orphanChildren =
    opts.orchPid !== undefined ? await sweepOrphans(opts.orchPid, processService) : []

  const tracker = getExitTracker(handle)
  // Yield to the microtask queue so an already-resolved `wait()` promise's
  // latching callback can fire before we read the tracker's state. Without
  // this, the very first snapshot taken after orch exits would still see
  // `alive: true` because the .then-callback subscription happens within the
  // same synchronous block as the read.
  await Promise.resolve()
  await Promise.resolve()
  const exitState = tracker.state()
  const orchAlive = exitState.alive
  const orchExit = exitState.alive ? null : exitState.exit

  const capturedAtMs = clock.now()
  const orchAliveDurationMs = Math.max(0, capturedAtMs - spawnedAtMs)

  return {
    orchAlive,
    orchExit,
    tmuxSessionExists,
    tmuxServerExists,
    panesAlive,
    leftPaneText,
    rightPaneText,
    leftPaneFocused,
    rightPaneFocused,
    stateStatus,
    stepStatuses,
    perStepFilesIntact,
    stdoutAltScreen,
    stdoutMouseTracking,
    orphanChildren,
    capturedAtMs,
    orchAliveDurationMs,
  }
}

async function safeBool(p: Promise<boolean>): Promise<boolean> {
  try {
    return await p
  } catch {
    return false
  }
}

async function safeListPanes(probe: ExternalTmuxProbe): Promise<readonly PaneSnapshot[]> {
  try {
    return await probe.listPanes()
  } catch {
    return []
  }
}

async function safeCapture(probe: ExternalTmuxProbe, pane: 'left' | 'right'): Promise<string> {
  try {
    return await probe.capturePaneText(pane)
  } catch {
    return ''
  }
}

async function safeFocused(probe: ExternalTmuxProbe, pane: 'left' | 'right'): Promise<boolean> {
  try {
    return await probe.isPaneFocused(pane)
  } catch {
    return false
  }
}

interface StateJsonView {
  readonly stateStatus: StateStatus
  readonly stepStatuses: Readonly<Record<string, StepStatus>>
}

async function readStateJson(handle: OrchHandle): Promise<StateJsonView> {
  const filePath = nodePath.join(handle.stateDir, 'state.json')
  try {
    const raw = await Bun.file(filePath).text()
    if (raw.length === 0) return { stateStatus: 'unknown', stepStatuses: {} }
    const parsed = JSON.parse(raw) as {
      status?: string
      steps?: Record<string, { endedAt?: number; value?: unknown }>
    }
    const stepStatuses: Record<string, StepStatus> = {}
    if (parsed.steps !== undefined) {
      for (const [name, entry] of Object.entries(parsed.steps)) {
        // `state-store.saveStep` writes the entry once the step terminates
        // successfully (see `src/core/workflow.ts:1189`). Presence of the
        // entry IS the completion signal — `value` can legitimately be
        // `undefined` for agent steps with no structured output. The earlier
        // heuristic `value !== undefined` mis-reported puppet completes as
        // `unknown`.
        if (entry !== undefined && entry.endedAt !== undefined) {
          stepStatuses[name] = 'completed'
        } else {
          stepStatuses[name] = 'unknown'
        }
      }
    }
    // Failed steps do NOT appear in state.steps — `saveStep` is skipped when
    // the step throws (src/core/workflow.ts:1235-1252). Augment the per-step
    // map from `logs/lifecycle.ndjson`. Note: state.json is authoritative; a
    // step with a successful entry stays `completed` even if a stale
    // `step:failed` line from a prior (resumed) run is present.
    const failed = await readFailedSteps(handle)
    for (const name of failed) {
      if (stepStatuses[name] !== 'completed') {
        stepStatuses[name] = 'failed'
      }
    }
    return { stateStatus: mapStateStatus(parsed.status), stepStatuses }
  } catch {
    return { stateStatus: 'unknown', stepStatuses: {} }
  }
}

async function readFailedSteps(handle: OrchHandle): Promise<Set<string>> {
  const lifecycleFile = nodePath.join(handle.stateDir, 'logs', 'lifecycle.ndjson')
  try {
    const raw = await Bun.file(lifecycleFile).text()
    if (raw.length === 0) return new Set()
    const out = new Set<string>()
    for (const line of raw.split('\n')) {
      if (line.length === 0) continue
      try {
        const parsed = JSON.parse(line) as { type?: string; stepName?: string }
        if (parsed.type === 'step:failed' && typeof parsed.stepName === 'string') {
          out.add(parsed.stepName)
        }
      } catch {
        /* tolerate trailing partial / malformed line */
      }
    }
    return out
  } catch {
    return new Set()
  }
}

function mapStateStatus(raw: string | undefined): StateStatus {
  if (raw === undefined) return 'unknown'
  if (raw === 'running' || raw === 'completed' || raw === 'crashed') return raw
  if (raw === 'cancelled' || raw === 'failed') return raw
  return 'unknown'
}

async function checkPerStepFiles(
  handle: OrchHandle,
  stepStatuses: Readonly<Record<string, StepStatus>>,
): Promise<PerStepFilesIntact> {
  const out: Record<string, boolean> = {}
  for (const stepName of Object.keys(stepStatuses)) {
    out[stepName] = await checkOneStep(handle.stateDir, stepName)
  }
  return out
}

async function checkOneStep(stateDir: string, stepName: string): Promise<boolean> {
  // Steps with no on-disk output yet are vacuously intact — there's nothing
  // to be truncated. When files exist, every one must end with `\n`.
  const candidates = [
    nodePath.join(stateDir, 'agents', stepName, 'formatted_output.ansi'),
    nodePath.join(stateDir, 'agents', stepName, 'formatted_output.txt'),
  ]
  for (const p of candidates) {
    if (!existsSync(p)) continue
    if (!(await checkFileIntact(p))) return false
  }
  return true
}

async function checkFileIntact(filePath: string): Promise<boolean> {
  try {
    const body = await Bun.file(filePath).text()
    if (body.length === 0) return true // empty file is vacuously intact
    return body.endsWith('\n')
  } catch {
    return false
  }
}

const ALT_ENTER = Buffer.from('\x1b[?1049h')
const ALT_EXIT = Buffer.from('\x1b[?1049l')
const MOUSE_1000_ON = Buffer.from('\x1b[?1000h')
const MOUSE_1003_ON = Buffer.from('\x1b[?1003h')
const MOUSE_1000_OFF = Buffer.from('\x1b[?1000l')
const MOUSE_1003_OFF = Buffer.from('\x1b[?1003l')

export function countAltScreen(bytes: Buffer): EscapeCounts {
  return { enters: countOccurrences(bytes, ALT_ENTER), exits: countOccurrences(bytes, ALT_EXIT) }
}

export function countMouseTracking(bytes: Buffer): MouseTrackingCounts {
  return {
    ons: countOccurrences(bytes, MOUSE_1000_ON) + countOccurrences(bytes, MOUSE_1003_ON),
    offs: countOccurrences(bytes, MOUSE_1000_OFF) + countOccurrences(bytes, MOUSE_1003_OFF),
  }
}

function countOccurrences(haystack: Buffer, needle: Buffer): number {
  if (needle.length === 0) return 0
  let count = 0
  let idx = 0
  while (idx <= haystack.length - needle.length) {
    const found = haystack.indexOf(needle, idx)
    if (found === -1) return count
    count += 1
    idx = found + needle.length
  }
  return count
}

async function sweepOrphans(
  orchPid: number,
  processService: ProcessService,
): Promise<readonly OrphanChild[]> {
  const visited = new Set<number>([orchPid])
  const out: OrphanChild[] = []
  const stack: number[] = [orchPid]
  while (stack.length > 0) {
    const pid = stack.pop()
    if (pid === undefined) break
    const children = await listChildrenOf(pid, processService)
    for (const child of children) {
      if (visited.has(child.pid)) continue
      visited.add(child.pid)
      if (pid !== orchPid) out.push({ pid: child.pid, ppid: pid, command: child.command })
      stack.push(child.pid)
    }
  }
  return out
}

interface PgrepChild {
  readonly pid: number
  readonly command: string
}

async function listChildrenOf(
  parentPid: number,
  processService: ProcessService,
): Promise<readonly PgrepChild[]> {
  const { stdout, exitCode } = await runShell(processService, [
    'pgrep',
    '-P',
    String(parentPid),
    '-l',
  ])
  if (exitCode !== 0 && exitCode !== 1) return []
  const children: PgrepChild[] = []
  for (const line of stdout.split('\n')) {
    const child = parsePgrepLine(line)
    if (child !== undefined) children.push(child)
  }
  return children
}

function parsePgrepLine(line: string): PgrepChild | undefined {
  const trimmed = line.trim()
  if (trimmed.length === 0) return undefined
  const [pidRaw, ...cmdParts] = trimmed.split(/\s+/)
  const pid = Number(pidRaw)
  if (!Number.isFinite(pid)) return undefined
  return { pid, command: cmdParts.join(' ') }
}

async function runShell(
  processService: ProcessService,
  argv: readonly string[],
): Promise<{ stdout: string; exitCode: number }> {
  const handle = processService.spawn({
    argv,
    cwd: toPath('/'),
    env: passthroughEnv(),
  })
  const outParts: string[] = []
  const drainOut = (async () => {
    for await (const line of handle.stdout) outParts.push(line)
  })()
  const drainErr = (async () => {
    for await (const _line of handle.stderr) {
      /* swallow */
    }
  })()
  const [{ exitCode }] = await Promise.all([handle.wait(), drainOut, drainErr])
  return { stdout: outParts.join('\n'), exitCode }
}

function passthroughEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) out[k] = v
  }
  return out
}
