// ---------------------------------------------------------------------------
// orch logs <runId> — stream the per-step transcript NDJSON.
// ---------------------------------------------------------------------------
//
// `state.json` stores per-step pointers to `.orch/state/<runId>/steps/<name>
// .transcript.ndjson`. This command streams those sidecars in step order,
// either as readable text lines or as the raw NDJSON envelope.
//
// Path-traversal guard: the incoming `runId` is piped through the `runId()`
// smart constructor *before* any fs access, so `orch logs ../../etc/passwd`
// exits 2 without touching the filesystem. Every fs read is pinned under
// `<basePath>/<runId>/` — there is no way for a bad runId to escape.

import type { WorkflowArgs } from '../../core/index.ts'
import { renderTranscriptLine } from '../../hosts/index.ts'
import type { RunnerEvent } from '../../runners/index.ts'
import type { Path } from '../../services/types.ts'
import { path } from '../../services/types.ts'
import { runId as parseRunId, StateCorruptionError } from '../../state/index.ts'
import type { CliDeps } from '../deps.ts'
import { type CliOpts, EXIT } from '../main.ts'

export async function logsCmd(
  deps: CliDeps,
  idArg: string,
  _args: WorkflowArgs = {},
  opts: CliOpts = { mode: undefined, format: 'text', noAttach: false, debug: false },
): Promise<number> {
  if (!idArg) {
    process.stderr.write('Usage: orch logs <runId>\n')
    return EXIT.CONFIG_ERROR
  }

  // Validate before any fs touch — prevents `../` traversal at the entry point.
  let rid: ReturnType<typeof parseRunId>
  try {
    rid = parseRunId(idArg)
  } catch {
    process.stderr.write(`orch: invalid runId "${idArg}"\n`)
    return EXIT.CONFIG_ERROR
  }

  const loaded = await loadState(deps, rid)
  if (typeof loaded === 'number') return loaded

  const stepEntries = Object.values(loaded.steps).sort((a, b) => a.startedAt - b.startedAt)
  const runDir: Path = path(`${deps.statePath}/${rid}`)

  for (const step of stepEntries) {
    await streamStepTranscript(deps, runDir, step, opts.format)
  }

  return EXIT.OK
}

async function loadState(
  deps: CliDeps,
  rid: ReturnType<typeof parseRunId>,
): Promise<NonNullable<Awaited<ReturnType<typeof deps.stateStore.loadRun>>> | number> {
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

async function streamStepTranscript(
  deps: CliDeps,
  runDir: Path,
  step: { readonly name: string; readonly transcriptPath?: string },
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
  const rendered = renderTranscriptLine(event)
  if (rendered === null) return
  process.stdout.write(`[${stepName}] ${rendered}\n`)
}
