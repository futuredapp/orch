// ---------------------------------------------------------------------------
// orch logs <runId> [--step <name>] [--follow|-f]
// orch logs --latest [--step <name>] [--follow|-f]
// ---------------------------------------------------------------------------
//
// File size note (CLAUDE.md rule 5): exceeds the 300-line soft cap because
// the four behaviors of `orch logs` (one-shot, --latest, --step, --follow)
// share enough state (resolved runId, loaded RunState, runDir, step entries)
// that splitting them into separate files duplicates wiring without
// reducing complexity. The tail loop itself is split into `tail-lines.ts`.
// ---------------------------------------------------------------------------
//
// `state.json` stores per-step pointers to
// `.orch/state/<runId>/logs/agents/<name>/events.ndjson`. This command streams
// those sidecars in step order, either as readable text lines or as the raw
// NDJSON envelope. Older runs persisted `steps/<name>.transcript.ndjson`; the
// `transcriptPath` literal in state.json reads either layout transparently.
//
// `--latest` (PR B) resolves the run at command time via `RunRegistry.listRuns`
// — a snapshot, not a switch. If a new run starts during a tail, the tail
// keeps pointing at the originally resolved id.
//
// `--step <name>` (PR B) filters the printed transcripts to one named step.
// Exact match only — runIds need prefix matching because they're hashes,
// step names don't because they're user-authored. No-match exits 2.
//
// `--follow` (PR B) opens an inline tail loop on the named step's transcript
// and races it against a status poll. The loop ends when the run reaches a
// terminal status (`completed` or `crashed`) or SIGINT. Requires `--step`
// so we always know which file to tail.
//
// Path-traversal guard: the incoming `runId` is piped through the `runId()`
// smart constructor *before* any fs access, so `orch logs ../../etc/passwd`
// exits 2 without touching the filesystem. Every fs read is pinned under
// `<basePath>/<runId>/` — there is no way for a bad runId to escape.

import type { WorkflowArgs } from '../../core/index.ts'
import { renderTranscriptLine } from '../../hosts/index.ts'
import { toClaudeTranscriptLines } from '../../runners/claude/format-event.ts'
import type { RunnerEvent } from '../../runners/index.ts'
import type { Path } from '../../services/types.ts'
import { path } from '../../services/types.ts'
import { runId as parseRunId, type RunState, StateCorruptionError } from '../../state/index.ts'
import type { CliDeps } from '../deps.ts'
import { type CliOpts, EXIT } from '../main.ts'
import { tailLines } from './tail-lines.ts'

// Re-export for the unit test that exercises the helper directly. The
// helper lives in its own file (`tail-lines.ts`) for the file-size budget
// (CLAUDE.md rule 5).
export { tailLines }

// ---------------------------------------------------------------------------
// Public entry — `orch logs` dispatcher
// ---------------------------------------------------------------------------

export async function logsCmd(
  deps: CliDeps,
  idArg: string,
  _args: WorkflowArgs = {},
  opts: CliOpts = defaultOpts(),
): Promise<number> {
  // `--latest` and a positional runId are mutually exclusive — the user
  // told us *both* what to resolve and what they wanted. Refuse rather
  // than guess which one they meant.
  if (opts.latest && idArg.length > 0) {
    process.stderr.write('orch: --latest is mutually exclusive with a positional runId\n')
    return EXIT.CONFIG_ERROR
  }

  // `--follow` requires `--step` — without a step we don't know which
  // transcript file to tail. Fail loud, point at the missing flag.
  if (opts.follow && opts.step === undefined) {
    process.stderr.write('orch: --follow requires --step <name> to know which transcript to tail\n')
    return EXIT.CONFIG_ERROR
  }

  const resolved = await resolveRunId(deps, idArg, opts.latest)
  if (typeof resolved === 'number') return resolved
  const rid = resolved

  const loaded = await loadState(deps, rid)
  if (typeof loaded === 'number') return loaded
  const state = loaded

  const stepEntries = pickStepEntries(state, opts.step)
  if (typeof stepEntries === 'number') return stepEntries

  const runDir: Path = path(`${deps.statePath}/${rid}`)

  if (opts.follow) {
    return await runFollow(deps, rid, runDir, stepEntries[0], opts.format)
  }

  for (const step of stepEntries) {
    await streamStepTranscript(deps, runDir, step, opts.format)
  }
  return EXIT.OK
}

// ---------------------------------------------------------------------------
// runId resolution
// ---------------------------------------------------------------------------

async function resolveRunId(
  deps: CliDeps,
  idArg: string,
  latest: boolean,
): Promise<ReturnType<typeof parseRunId> | number> {
  if (latest) {
    const runs = await deps.registry.listRuns()
    const last = runs.at(-1)
    if (last === undefined) {
      process.stderr.write('No runs found\n')
      return EXIT.CONFIG_ERROR
    }
    return last
  }

  if (!idArg) {
    process.stderr.write('Usage: orch logs <runId> | orch logs --latest\n')
    return EXIT.CONFIG_ERROR
  }

  try {
    return parseRunId(idArg)
  } catch {
    process.stderr.write(`orch: invalid runId "${idArg}"\n`)
    return EXIT.CONFIG_ERROR
  }
}

async function loadState(
  deps: CliDeps,
  rid: ReturnType<typeof parseRunId>,
): Promise<RunState | number> {
  let state: Awaited<ReturnType<typeof deps.stateStore.loadRun>>
  try {
    state = await deps.stateStore.loadRun(rid)
  } catch (err) {
    if (err instanceof StateCorruptionError) {
      process.stderr.write(`${err.message}\n`)
      return EXIT.CONFIG_ERROR
    }
    throw err
  }
  if (!state) {
    process.stderr.write(`Run "${rid}" not found\n`)
    return EXIT.CONFIG_ERROR
  }
  return state
}

// ---------------------------------------------------------------------------
// Step filtering
// ---------------------------------------------------------------------------

type StepEntry = RunState['steps'][string]

function pickStepEntries(
  state: RunState,
  stepQuery: string | undefined,
): readonly StepEntry[] | number {
  const all = Object.values(state.steps).sort((a, b) => a.startedAt - b.startedAt)
  if (stepQuery === undefined) return all

  const entry = all.find((s) => s.name === stepQuery)
  if (entry === undefined) {
    const names = all.map((s) => s.name).join(', ')
    process.stderr.write(
      `No step matching "${stepQuery}" in run ${state.id} (steps: ${names || '<none>'})\n`,
    )
    return EXIT.CONFIG_ERROR
  }
  return [entry]
}

// ---------------------------------------------------------------------------
// One-shot transcript streaming (the existing behavior)
// ---------------------------------------------------------------------------

async function streamStepTranscript(
  deps: CliDeps,
  runDir: Path,
  step: StepEntry,
  format: CliOpts['format'],
): Promise<void> {
  if (step.transcriptPath === undefined) return
  const sidecar: Path = path(`${runDir}/${step.transcriptPath}`)
  let raw: string
  try {
    raw = await deps.fsService.readFile(sidecar)
  } catch {
    // Step recorded a pointer but the file isn't there (user pruned,
    // partial flush). Skip silently — other steps may still have output.
    return
  }
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue
    printEvent(step.name, line, format)
  }
}

function printEvent(stepName: string, line: string, format: CliOpts['format']): void {
  if (format === 'json') {
    process.stdout.write(`${line}\n`)
    return
  }
  let event: RunnerEvent
  try {
    event = JSON.parse(line) as RunnerEvent
  } catch {
    return
  }
  // Phase A: assume Claude-shaped events. The persisted NDJSON doesn't carry
  // a runner tag yet; Phase E (`orch logs` reframe) will read the runner from
  // state.json and dispatch through the runner registry.
  const lines = toClaudeTranscriptLines(event)
  if (lines.length === 0) return
  const color = process.stdout.isTTY === true && !process.env.NO_COLOR
  const prefix = `[${stepName}] `
  for (const tl of lines) {
    const rendered = renderTranscriptLine(tl, {
      color,
      prefix: tl.kind === 'line' ? prefix : '',
    })
    for (const out of rendered) process.stdout.write(`${out}\n`)
  }
}

// ---------------------------------------------------------------------------
// --follow — tail-and-poll loop
// ---------------------------------------------------------------------------
//
// Two concurrent loops, both racing the same AbortSignal:
//   - tail: poll the transcript file's tail, yield newline-terminated chunks
//   - status poll: re-read state.json every second; when terminal, abort
//
// SIGINT also aborts. On exit we flush any pending partial line so streams
// that ended mid-line still print what we received. The contract pinned by
// the unit test against a real tmpdir.

const STATUS_POLL_MS = 1000

const isTerminalStatus = (s: RunState['status']): boolean => s === 'completed' || s === 'crashed'

async function runFollow(
  deps: CliDeps,
  rid: ReturnType<typeof parseRunId>,
  runDir: Path,
  step: StepEntry | undefined,
  format: CliOpts['format'],
): Promise<number> {
  if (step === undefined) {
    // pickStepEntries already errored on no-match; we shouldn't get here.
    process.stderr.write('orch: --follow target step missing\n')
    return EXIT.CONFIG_ERROR
  }

  // Already-terminal short-circuit — print the persisted transcript and
  // exit without entering the tail loop. Saves the user a needless wait.
  const initial = await deps.stateStore.loadRun(rid)
  if (initial !== undefined && isTerminalStatus(initial.status)) {
    await streamStepTranscript(deps, runDir, step, format)
    return EXIT.OK
  }

  if (step.transcriptPath === undefined) {
    // The step has no sidecar yet (silent step, or just hasn't started).
    // Still tail — the writer creates the file on first append. Pick a
    // sensible default location aligned with the writer's contract.
    process.stderr.write(`orch: step "${step.name}" has no transcript path yet; waiting…\n`)
    return EXIT.CONFIG_ERROR
  }

  const filePath: Path = path(`${runDir}/${step.transcriptPath}`)
  const abort = new AbortController()
  const onSigint = (): void => {
    abort.abort()
  }
  process.once('SIGINT', onSigint)

  let sigintFired = false
  abort.signal.addEventListener('abort', () => {
    sigintFired = sigintFired || abort.signal.reason === 'sigint'
  })

  try {
    await Promise.race([
      drainTail(filePath, step.name, format, abort.signal),
      pollStatusUntilTerminal(deps, rid, abort),
    ])
  } finally {
    process.off('SIGINT', onSigint)
    abort.abort()
  }
  return sigintFired ? EXIT.SIGINT : EXIT.OK
}

async function drainTail(
  filePath: Path,
  stepName: string,
  format: CliOpts['format'],
  signal: AbortSignal,
): Promise<void> {
  for await (const line of tailLines(filePath, signal)) {
    printEvent(stepName, line, format)
  }
}

async function pollStatusUntilTerminal(
  deps: CliDeps,
  rid: ReturnType<typeof parseRunId>,
  abort: AbortController,
): Promise<void> {
  while (!abort.signal.aborted) {
    await Bun.sleep(STATUS_POLL_MS)
    if (abort.signal.aborted) return
    const state = await deps.stateStore.loadRun(rid)
    if (state !== undefined && isTerminalStatus(state.status)) {
      abort.abort()
      return
    }
  }
}

// ---------------------------------------------------------------------------
// Defaults — keeps the function usable from tests that don't pass CliOpts
// ---------------------------------------------------------------------------

function defaultOpts(): CliOpts {
  return {
    mode: undefined,
    format: 'text',
    noAttach: false,
    debug: false,
    interactivity: 'interactive',
    latest: false,
    step: undefined,
    follow: false,
    watch: false,
  }
}
