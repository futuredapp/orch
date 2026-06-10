import type { WorkflowArgs } from '../../core/index.ts'
import type { RunId } from '../../state/index.ts'
import { StateCorruptionError } from '../../state/index.ts'
import type { CliDeps } from '../deps.ts'
import { type CliOpts, EXIT, type HostFactory } from '../main.ts'
import { openFailed } from './open-failed.ts'
import { openFinished } from './open-finished.ts'
import { runResumeExecution } from './resume-execution.ts'

const SCAN_CAP = 50

async function findResumableRun(deps: CliDeps): Promise<RunId | undefined> {
  const runs = await deps.registry.listRuns()
  const recent = runs.slice(-SCAN_CAP).reverse()

  for (const rid of recent) {
    // A corrupt recent run must not abort the whole scan: skip it (it couldn't
    // be resumed anyway) so a single bad run can't defeat the bare-resume
    // finished-run fallback below — its sibling `findNewestFinishedRunId`
    // already skips corruption, and the asymmetry would silently swallow D5.
    let state: Awaited<ReturnType<typeof deps.stateStore.loadRun>>
    try {
      state = await deps.stateStore.loadRun(rid)
    } catch (err) {
      if (err instanceof StateCorruptionError) continue
      throw err
    }
    if (state && (state.status === 'crashed' || state.status === 'running')) {
      return rid
    }
  }
  return undefined
}

async function findByPrefix(deps: CliDeps, prefix: string): Promise<RunId | undefined> {
  const matches = await deps.registry.findByPrefix(prefix)
  if (matches.length === 0) return undefined
  if (matches.length > 1) {
    process.stderr.write(
      `Ambiguous run ID prefix "${prefix}" matches ${matches.length} runs: ${matches.join(', ')}\n`,
    )
    return undefined
  }
  return matches[0]
}

/**
 * Newest finished (`completed`/`failed`) run, scanning recent runs newest-first.
 * Powers the status-aware bare-resume fallback (U7/D5): when no resumable run
 * exists, this is the run we offer to open. Corrupt runs are skipped (they
 * couldn't be opened anyway) so the offer lands on the newest *openable*
 * finished run.
 */
async function findNewestFinishedRunId(deps: CliDeps): Promise<RunId | undefined> {
  const runs = await deps.registry.listRuns()
  const recent = runs.slice(-SCAN_CAP).reverse()

  for (const rid of recent) {
    let state: Awaited<ReturnType<typeof deps.stateStore.loadRun>>
    try {
      state = await deps.stateStore.loadRun(rid)
    } catch (err) {
      if (err instanceof StateCorruptionError) continue
      throw err
    }
    if (state && (state.status === 'completed' || state.status === 'failed')) {
      return rid
    }
  }
  return undefined
}

export interface ResolvedResumeTarget {
  readonly targetId: RunId
  readonly state: NonNullable<Awaited<ReturnType<CliDeps['stateStore']['loadRun']>>>
  readonly workflowName: string
}

/** Load + validate a resolved run id into a `ResolvedResumeTarget`, or a
 *  non-zero exit code with the matching stderr message. Shared by the explicit
 *  path, the bare resumable path, and the bare finished-run fallback. */
async function loadResumeTarget(
  deps: CliDeps,
  targetId: RunId,
): Promise<ResolvedResumeTarget | number> {
  let state: Awaited<ReturnType<typeof deps.stateStore.loadRun>>
  try {
    state = await deps.stateStore.loadRun(targetId)
  } catch (err) {
    if (err instanceof StateCorruptionError) {
      process.stderr.write(`${err.message}\n`)
      return EXIT.CONFIG_ERROR
    }
    throw err
  }
  if (!state) {
    process.stderr.write(`Run "${targetId}" not found\n`)
    return EXIT.CANNOT_RESUME
  }
  if (!state.workflowName) {
    process.stderr.write(
      `Run "${targetId}" has no workflowName (v2 state). ` +
        'Provide the workflow name: orch run <name>\n',
    )
    return EXIT.CANNOT_RESUME
  }
  return { targetId, state, workflowName: state.workflowName }
}

/** Resolve an explicit run-id argument (prefix match) into a validated
 *  `ResolvedResumeTarget`, or a non-zero exit code on ambiguous/not-found.
 *  Shared with `orch retry` (U8) so both verbs use one prefix/not-found path. */
export async function resolveExplicitTarget(
  deps: CliDeps,
  idArg: string,
): Promise<ResolvedResumeTarget | number> {
  const targetId = await findByPrefix(deps, idArg)
  if (targetId === undefined) {
    process.stderr.write(`No run found matching "${idArg}"\n`)
    return EXIT.CANNOT_RESUME
  }
  return loadResumeTarget(deps, targetId)
}

export async function resumeCmd(
  deps: CliDeps,
  idArg: string,
  cliArgs: WorkflowArgs,
  opts: CliOpts,
  hostFactory: HostFactory,
): Promise<number> {
  // Target resolution diverges by invocation shape:
  //   - explicit id → prefix resolution (ambiguous/not-found unchanged).
  //   - bare `orch resume` → prefer a resumable (`crashed`/`running`) run; when
  //     none exists, offer the newest finished run behind a status-aware
  //     confirmation (U7/D5). A resumable run is never displaced by a finished
  //     one (AT-9).
  let resolved: ResolvedResumeTarget | number
  if (idArg) {
    resolved = await resolveExplicitTarget(deps, idArg)
  } else {
    const resumableId = await findResumableRun(deps)
    if (resumableId === undefined) {
      return bareFinishedFallback(deps, cliArgs, opts, hostFactory)
    }
    resolved = await loadResumeTarget(deps, resumableId)
  }
  if (typeof resolved === 'number') return resolved
  const { targetId, state, workflowName } = resolved

  // A finished run is a dead end for `executor.resume()` on `completed` (it
  // would throw `ResumeError`) and a *silent re-run* on `failed` (the guard
  // only fires on `completed`). Branch both into deliberate re-entry:
  //
  //   - `completed` → the read-only end-of-run viewer (D1/D2, Phase 1).
  //   - `failed`    → the interactive failure view (D2/D3, Phase 2/U6) — park,
  //                   never silently re-run.
  //
  // Both are TUIs: with no interactive two-pane terminal (no TTY / tmux
  // unavailable) we refuse rather than open/hang/mutate (D8 / AT-20). The
  // resolved run mode is the load-bearing signal — a piped/CI invocation
  // resolves to `plain`, never `two-pane`. `crashed`/`running` resume for real,
  // unchanged.
  if (state.status === 'completed' || state.status === 'failed') {
    if (opts.mode !== 'two-pane') {
      // Non-zero, but deliberately NOT `CANNOT_RESUME`: a finished run must
      // never surface the "cannot resume" code (AT-6). This is an
      // environment-capability refusal, mapped to `CONFIG_ERROR`. The `failed`
      // half is the key v2 fix — no TTY no longer silently re-runs the step.
      process.stderr.write(
        `Cannot open run ${targetId}: it is ${state.status} and the interactive view ` +
          `requires two-pane mode (got mode=${opts.mode}; e.g. --mode=plain / no TTY / tmux unavailable).\n`,
      )
      return EXIT.CONFIG_ERROR
    }
    if (state.status === 'completed') {
      return openFinished({
        deps,
        targetId,
        workflowName,
        status: state.status,
        opts,
        hostFactory,
      })
    }
    return openFailed({ deps, targetId, state, workflowName, cliArgs, opts, hostFactory })
  }

  process.stderr.write(`Resuming run ${targetId}...\n`)
  return runResumeExecution({
    deps,
    targetId,
    state,
    workflowName,
    cliArgs,
    opts,
    hostFactory,
  })
}

/**
 * Status-aware bare-resume fallback (U7 / D5). Reached only when bare `orch
 * resume` found no resumable (`crashed`/`running`) run. It offers the newest
 * finished run behind a confirmation whose copy distinguishes the open kind —
 * read-only (completed) vs the interactive failure view (failed) — because
 * opening a failed run lands in a mutating-capable view. The confirmation is
 * *only* offered on an interactive two-pane terminal: with no TTY (or no
 * finished run at all) the command keeps today's "no resumable run found",
 * never auto-opening and never prompting (AT-13 / AT-21 / D8).
 */
async function bareFinishedFallback(
  deps: CliDeps,
  cliArgs: WorkflowArgs,
  opts: CliOpts,
  hostFactory: HostFactory,
): Promise<number> {
  const finishedId = opts.mode === 'two-pane' ? await findNewestFinishedRunId(deps) : undefined
  if (finishedId === undefined) {
    process.stderr.write('No resumable run found (no crashed or running runs)\n')
    return EXIT.CANNOT_RESUME
  }

  const resolved = await loadResumeTarget(deps, finishedId)
  if (typeof resolved === 'number') return resolved
  const { targetId, state, workflowName } = resolved

  // The open kind is the load-bearing distinction (AT-10): a completed run is
  // observation-only; a failed run opens the interactive view where retry /
  // continue can mutate.
  const openKind =
    state.status === 'completed'
      ? 'read-only'
      : 'the interactive failure view (retry/continue available)'
  const proceed = await deps.confirmService.confirm(
    `No resumable run found. Most recent run ${targetId} (${workflowName}) is ${state.status}. ` +
      `Open it in ${openKind}?`,
    false,
  )
  if (!proceed) {
    process.stderr.write('Nothing to resume.\n')
    return EXIT.OK
  }

  if (state.status === 'completed') {
    return openFinished({ deps, targetId, workflowName, status: state.status, opts, hostFactory })
  }
  return openFailed({ deps, targetId, state, workflowName, cliArgs, opts, hostFactory })
}
