/**
 * Internal subprocess helpers — spawn orch via `BunProcessService` with
 * `rawStreams: true`, parse `runId` from stderr, derive the tmux socket.
 *
 * Consumed by `launch.ts`'s `launchOrchWorkflow`. Tests MUST NOT import this
 * file directly — go through `tests/helpers/behavioral-dsl/index.ts`.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import {
  BunProcessService,
  mergeEnv,
  type SpawnHandle,
} from '../../../../src/services/process/index.ts'
import { path as toPath } from '../../../../src/services/types.ts'
import type { BringToStateRequest, OrchHandle, RunId, Socket } from './lifecycle-handle.ts'
import { resolveFixture } from './workflow-fixtures.ts'

// Anchor the runId line that `src/cli/commands/run.ts:104` writes to stderr:
//   Running workflow "<name>" (r-YYYY-MM-DD-HHMMSS-xx)[ with prompt: …]...
const RUNID_LINE_RE = /Running workflow "[^"]+" \((r-\d{4}-\d{2}-\d{2}-\d{6}-[a-z0-9]{2})\)/

const DEFAULT_SPAWN_TO_RUNID_TIMEOUT_MS = 10_000
const DEFAULT_BRING_TO_STATE_TIMEOUT_MS = 15_000
const DEFAULT_STATE_POLL_INTERVAL_MS = 50

const ORCH_LIFECYCLE_SCRIPT_ENV = 'ORCH_LIFECYCLE_SCRIPT'
const ORCH_STATE_BASE_ENV = 'ORCH_STATE_BASE'

export interface SpawnOrchOptions {
  readonly workflowFixture: string
  /**
   * Per-step script keyed by step name. Serialized to
   * `<stateBase>/script.json` and passed via `ORCH_LIFECYCLE_SCRIPT`. Each
   * value is a `StepScript` from `src/runners/scripted-fake/types.ts`. Shape
   * kept loose here so this file does not import the runner module across
   * the harness/runner seam at type-position.
   */
  readonly script?: Readonly<Record<string, unknown>>
  readonly mode?: 'two-pane'
  readonly bringToState?: BringToStateRequest
  readonly env?: Readonly<Record<string, string>>
  readonly spawnToRunIdTimeoutMs?: number
  readonly bringToStateTimeoutMs?: number
}

export const spawnOrch = async (opts: SpawnOrchOptions): Promise<OrchHandle> => {
  const fixture = resolveFixture(opts.workflowFixture)
  const stateBaseRaw = await mkdtemp(nodePath.join(tmpdir(), 'orch-tier5-'))
  const stateBase = toPath(stateBaseRaw)

  // The orch subprocess inherits ORCH_STATE_BASE → state lands inside our
  // isolated tmpdir, not the fixture's `.orch/state`. createDeps reads this
  // env var (see src/cli/deps.ts).
  const scriptPath = nodePath.join(stateBaseRaw, 'script.json')
  const scriptBody = { steps: opts.script ?? {} }
  await writeFile(scriptPath, JSON.stringify(scriptBody), 'utf-8')

  const env = mergeEnv(
    process.env,
    {
      [ORCH_LIFECYCLE_SCRIPT_ENV]: scriptPath,
      [ORCH_STATE_BASE_ENV]: stateBaseRaw,
    },
    opts.env ?? {},
  )

  // Resolve `src/cli/main.ts` against the repo root (this file is at
  // `tests/helpers/behavioral-dsl/internal/`), not the orch subprocess's
  // cwd (which is the fixture directory).
  const repoRoot = nodePath.resolve(import.meta.dir, '../../../..')
  const orchEntry = nodePath.join(repoRoot, 'src/cli/main.ts')
  const argv: readonly string[] = [
    'bun',
    orchEntry,
    'run',
    fixture.workflowName,
    '--mode=two-pane',
    '--no-attach',
  ]

  // The workflow fixture is loaded by walking up from `fixture.cwd`, so we
  // set the subprocess cwd to the fixture root and rely on `findConfigPath`.
  const processService = new BunProcessService()
  const subprocess: SpawnHandle = processService.spawn({
    argv,
    env,
    cwd: fixture.cwd,
    rawStreams: true,
  })

  // Background pumps for both streams. Without these, orch's stderr/stdout
  // buffers fill (banner + tmux hints + status messages) and the subprocess
  // backpressures forever. The pumps run for the lifetime of the
  // subprocess; both are surfaced for diagnostics-on-failure.
  const stderrCollector = collectLines(subprocess.stderr)
  const stdoutCollector = collectLines(subprocess.stdout)

  let teardownCalled = false
  const teardown = async (): Promise<void> => {
    if (teardownCalled) return
    teardownCalled = true
    await killSubprocess(subprocess)
    await stderrCollector.done.catch(() => undefined)
    await stdoutCollector.done.catch(() => undefined)
    await rm(stateBaseRaw, { recursive: true, force: true }).catch(() => {})
  }

  let runId: RunId
  try {
    runId = await waitForRunIdLine(subprocess, stderrCollector, {
      timeoutMs: opts.spawnToRunIdTimeoutMs ?? DEFAULT_SPAWN_TO_RUNID_TIMEOUT_MS,
    })
  } catch (err) {
    await teardown()
    throw err
  }

  const socket = `orch-${runId}` as Socket
  const stateDir = toPath(`${stateBaseRaw}/${runId}`)

  const handle: OrchHandle = {
    runId,
    socket,
    stateBase,
    stateDir,
    env,
    subprocess,
    teardown,
  }

  if (opts.bringToState !== undefined) {
    try {
      await bringToState(handle, opts.bringToState, {
        timeoutMs: opts.bringToStateTimeoutMs ?? DEFAULT_BRING_TO_STATE_TIMEOUT_MS,
      })
    } catch (err) {
      await teardown()
      throw err
    }
  }

  return handle
}

interface LineCollector {
  /** All lines seen so far, in order. Mutated by the background pump. */
  readonly lines: string[]
  /** Listener for each new line. One listener per collector. */
  onLine: (line: string) => void
  /** Resolves when the underlying stream ends. */
  readonly done: Promise<void>
}

function collectLines(stream: AsyncIterable<string>): LineCollector {
  const collector: LineCollector = {
    lines: [],
    onLine: () => {
      /* default no-op */
    },
    done: Promise.resolve(),
  }
  const done = (async () => {
    for await (const line of stream) {
      collector.lines.push(line)
      try {
        collector.onLine(line)
      } catch {
        /* listener errors must not stop the pump */
      }
    }
  })().catch(() => undefined)
  // Reassign via `as` — the field is `readonly` to consumers but writable
  // here at construction time before any await.
  ;(collector as { done: Promise<void> }).done = done
  return collector
}

interface WaitForRunIdOptions {
  readonly timeoutMs: number
}

async function waitForRunIdLine(
  subprocess: SpawnHandle,
  collector: LineCollector,
  opts: WaitForRunIdOptions,
): Promise<RunId> {
  // Match against any already-collected lines (race-safe — the pump may
  // have already passed the runId before we attached a listener).
  for (const line of collector.lines) {
    const match = RUNID_LINE_RE.exec(line)
    if (match?.[1]) return match[1] as RunId
  }

  return new Promise<RunId>((resolve, reject) => {
    let settled = false
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      fn()
    }

    const timer = setTimeout(() => {
      settle(() =>
        reject(
          new RunIdParseError(
            `did not see "Running workflow" line within ${opts.timeoutMs}ms. ` +
              `Stderr tail:\n${collector.lines.slice(-20).join('\n')}`,
          ),
        ),
      )
    }, opts.timeoutMs)
    timer.unref()

    collector.onLine = (line: string): void => {
      const match = RUNID_LINE_RE.exec(line)
      if (match?.[1]) {
        clearTimeout(timer)
        settle(() => resolve(match[1] as RunId))
      }
    }

    void subprocess.wait().then(({ exitCode }) => {
      // Wait for the pump to drain trailing buffered lines before deciding
      // — orch may have written the runId moments before exiting.
      void collector.done.then(() => {
        if (settled) return
        clearTimeout(timer)
        settle(() =>
          reject(
            new RunIdParseError(
              `orch exited (code=${exitCode}) before emitting the runId line. ` +
                `Stderr tail:\n${collector.lines.slice(-20).join('\n')}`,
            ),
          ),
        )
      })
    })
  })
}

interface BringToStateOptions {
  readonly timeoutMs: number
  readonly pollIntervalMs?: number
}

async function bringToState(
  handle: OrchHandle,
  request: BringToStateRequest,
  opts: BringToStateOptions,
): Promise<void> {
  if (request.kind === 'pre-run') return

  const stateFile = nodePath.join(handle.stateDir, 'state.json')
  const pollMs = opts.pollIntervalMs ?? DEFAULT_STATE_POLL_INTERVAL_MS
  const deadline = Date.now() + opts.timeoutMs
  let lastError: string | undefined

  while (Date.now() < deadline) {
    const snapshot = await readStateSnapshot(stateFile)
    if (snapshot.kind === 'ok') {
      if (matchesRequest(snapshot.value, request)) return
      lastError = describeMismatch(snapshot.value, request)
    } else {
      lastError = snapshot.reason
    }
    await new Promise((res) => setTimeout(res, pollMs))
  }

  throw new BringToStateTimeoutError(
    `bringToState(${describeRequest(request)}) did not reach the target ` +
      `within ${opts.timeoutMs}ms. Last observation: ${lastError ?? '(none)'}`,
  )
}

interface StateSnapshot {
  readonly status: string
  readonly steps: Readonly<Record<string, { readonly value?: unknown }>>
}

type ReadResult =
  | { readonly kind: 'ok'; readonly value: StateSnapshot }
  | { readonly kind: 'missing' | 'parse-error'; readonly reason: string }

async function readStateSnapshot(stateFile: string): Promise<ReadResult> {
  try {
    const raw = await Bun.file(stateFile).text()
    if (raw.length === 0) {
      return { kind: 'parse-error', reason: 'empty state.json (mid-write)' }
    }
    const parsed = JSON.parse(raw) as StateSnapshot
    return { kind: 'ok', value: parsed }
  } catch (err) {
    if (err instanceof SyntaxError) {
      // Two-phase visibility on filesystem-backed state.json — treat parse
      // failure as "not yet ready" and continue polling (plan Risk R-H).
      return { kind: 'parse-error', reason: 'state.json mid-write (SyntaxError)' }
    }
    return { kind: 'missing', reason: 'state.json not yet visible' }
  }
}

function matchesRequest(state: StateSnapshot, request: BringToStateRequest): boolean {
  switch (request.kind) {
    case 'pre-run':
      return true
    case 'mid-step': {
      const entry = state.steps[request.name]
      // A step is "running" while it has an in-progress entry or no entry
      // yet that has produced a value. Tolerate both shapes: the executor
      // writes the entry once it has a value (completed) — so "running"
      // shows up either as missing or as present-without-value mid-flight.
      // Concretely, when the runner is held by `wait-for-file`, the step
      // entry has not yet been finalized.
      if (state.status !== 'running') return false
      const stepStarted = entry !== undefined || hasInProgressMarker(state, request.name)
      return stepStarted && entry?.value === undefined
    }
    case 'between-steps': {
      const after = state.steps[request.after]
      return after !== undefined && state.status === 'running'
    }
    case 'completed':
      return state.status === 'completed'
    case 'failed':
      return state.status === 'crashed'
    case 'awaiting-ask':
      // Heuristic: an ask step is mounted when state.json carries a step
      // entry with no value and a `kind: 'ask'`-like marker. Refined when
      // U8/U10 actually exercise this — for now mid-step naming is enough.
      return Object.values(state.steps).some((s) => s.value === undefined)
  }
}

function hasInProgressMarker(state: StateSnapshot, stepName: string): boolean {
  // Best-effort: when the executor has emitted lifecycle but not written a
  // value yet, the step entry is absent. We use that absence + status=running
  // as the "mid-step before first event" signal.
  return state.steps[stepName] === undefined && state.status === 'running'
}

function describeRequest(req: BringToStateRequest): string {
  switch (req.kind) {
    case 'pre-run':
      return 'pre-run'
    case 'mid-step':
      return `mid-step("${req.name}")`
    case 'between-steps':
      return `between-steps(after="${req.after}")`
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'awaiting-ask':
      return 'awaiting-ask'
  }
}

function describeMismatch(state: StateSnapshot, req: BringToStateRequest): string {
  return `status=${state.status}, steps=[${Object.keys(state.steps).join(', ')}] vs ${describeRequest(req)}`
}

async function killSubprocess(subprocess: SpawnHandle): Promise<void> {
  try {
    subprocess.kill('SIGTERM')
  } catch {
    // Already exited — no-op.
  }
  const gracefulDeadline = Date.now() + 1_000
  while (Date.now() < gracefulDeadline) {
    const exited = await Promise.race([
      subprocess.wait().then(() => true),
      new Promise<boolean>((res) => setTimeout(() => res(false), 50)),
    ])
    if (exited) return
  }
  try {
    subprocess.kill('SIGKILL')
  } catch {
    /* already gone */
  }
  await subprocess.wait().catch(() => undefined)
}

export class RunIdParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RunIdParseError'
  }
}

export class BringToStateTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BringToStateTimeoutError'
  }
}
