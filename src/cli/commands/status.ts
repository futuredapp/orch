import type { WorkflowArgs } from '../../core/index.ts'
import { type Path, path } from '../../services/index.ts'
import type { RunId } from '../../state/index.ts'
import { StateCorruptionError } from '../../state/index.ts'
import type { CliDeps } from '../deps.ts'
import { glyphs } from '../format.ts'
import { type CliOpts, EXIT } from '../main.ts'

const GLYPH = glyphs(process.stdout.isTTY ?? false)

export async function statusCmd(
  deps: CliDeps,
  idArg: string,
  _args: WorkflowArgs = {},
  _opts: CliOpts = {
    mode: undefined,
    format: 'text',
    noAttach: false,
    debug: false,
    interactivity: 'interactive',
    latest: false,
    step: undefined,
    follow: false,
    watch: false,
  },
): Promise<number> {
  if (!idArg) {
    process.stderr.write('Usage: orch status <id>\n')
    return EXIT.CONFIG_ERROR
  }

  // Resolve prefix
  const matches = await deps.registry.findByPrefix(idArg)
  if (matches.length === 0) {
    process.stderr.write(`No run found matching "${idArg}"\n`)
    return EXIT.CONFIG_ERROR
  }
  if (matches.length > 1) {
    process.stderr.write(
      `Ambiguous run ID prefix "${idArg}" matches ${matches.length} runs: ${matches.join(', ')}\n`,
    )
    return EXIT.CONFIG_ERROR
  }

  const rid = matches[0] as RunId

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

  const glyph = GLYPH[state.status]
  process.stdout.write(`Run:      ${state.id}\n`)
  process.stdout.write(`Status:   ${glyph} ${state.status}\n`)
  if (state.workflowName) {
    process.stdout.write(`Workflow: ${state.workflowName}\n`)
  }

  const stepEntries = Object.values(state.steps)
  if (stepEntries.length === 0) {
    process.stdout.write('Steps:    (none)\n')
  } else {
    process.stdout.write(`Steps:    ${stepEntries.length}\n\n`)
    // Persisted steps genuinely completed, so they keep `GLYPH.completed`. The
    // failing step is NOT in `state.steps` (only succeeded steps are saved), so
    // we never fabricate a failed glyph here — the Failure section below names it.
    for (const s of stepEntries) {
      const dur = s.endedAt - s.startedAt
      process.stdout.write(`  ${GLYPH.completed} ${s.name.padEnd(30)} ${dur}ms\n`)
    }
  }

  if (state.status === 'failed' || state.status === 'crashed') {
    await printFailureSection(deps, rid)
  }

  return EXIT.OK
}

interface StepFailure {
  readonly stepName: string
  readonly reason: string
}

/**
 * Print the failing step and its reason for a failed/crashed run. The reason is
 * NOT in `state.json` (the executor only `saveStep`s succeeded steps); it lives
 * as the last `step:failed` record in `<runDir>/logs/lifecycle.ndjson`. When the
 * log is absent or carries no such record, still print the `Details:` pointer so
 * the deeper trail is one copy-paste away, and never throw.
 */
async function printFailureSection(deps: CliDeps, rid: RunId): Promise<void> {
  const lifecyclePath = path(`${deps.stateStore.runDir(rid)}/logs/lifecycle.ndjson`)
  const failure = await readLastStepFailure(deps, lifecyclePath)

  process.stdout.write('\n')
  if (failure) {
    process.stdout.write(`Failed step: ${failure.stepName}\n`)
    process.stdout.write(`Reason:      ${failure.reason}\n`)
    process.stdout.write(`Details:     orch logs ${rid} --step ${failure.stepName}\n`)
  } else {
    process.stdout.write('Failed step: (unknown — see logs)\n')
    process.stdout.write(`Details:     orch logs ${rid}\n`)
  }
  process.stdout.write(`             ${lifecyclePath}\n`)
}

/**
 * Read `lifecycle.ndjson` line-by-line as NDJSON and return the LAST
 * `step:failed` record's step name + best-effort reason. Tolerates a missing
 * file (returns undefined) and blank/unparseable/truncated lines (skips them) —
 * a run killed mid-write must never make `status` throw.
 */
async function readLastStepFailure(
  deps: CliDeps,
  lifecyclePath: Path,
): Promise<StepFailure | undefined> {
  let raw: string
  try {
    raw = await deps.fsService.readFile(lifecyclePath)
  } catch {
    return undefined
  }

  let last: StepFailure | undefined
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      continue // truncated final line or garbage — skip, don't throw
    }
    if (!isStepFailedRecord(record)) continue
    // TODO: prefer persisted errorClass once plan 010 lands
    last = { stepName: record.stepName, reason: extractReason(record.error) }
  }
  return last
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function isStepFailedRecord(v: unknown): v is { stepName: string; error: unknown } {
  return isRecord(v) && v.type === 'step:failed' && typeof v.stepName === 'string'
}

/**
 * Extract a human message from a `step:failed` record's `error`. Error objects
 * often JSON-serialize to `{}` (their `message` isn't an own-enumerable field),
 * so this is best-effort: a string is used verbatim; an object with a string
 * `message` yields that; otherwise the caller is pointed at the transcript.
 */
function extractReason(error: unknown): string {
  if (typeof error === 'string' && error.length > 0) return error
  if (isRecord(error) && typeof error.message === 'string' && error.message.length > 0) {
    return error.message
  }
  return '(see transcript)'
}
