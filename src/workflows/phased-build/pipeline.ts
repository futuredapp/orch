// ---------------------------------------------------------------------------
// buildPhasedWorkflow — the single parameterized phased-build pipeline.
// ---------------------------------------------------------------------------
//
// One runner-agnostic factory drives both `orch::work-cc` and
// `orch::work-codex`: the only difference between the variants is the bound
// `runner`. The pipeline:
//
//   1. resolve-input   command — cat the argument; exit 0 → plan file text,
//                      non-zero → treat the argument as an inline description
//                      (R10, AE5).
//   2. truncate-phases command — empty the decide artifact BEFORE the decide
//                      step so a non-writing decide cannot read a prior run's
//                      leftover phases (silent-corruption guard, R-4).
//   3. decide-phases   interactive + autoStop agent — decides a fresh 1–4
//                      phase breakdown and writes it to the artifact (R5, R6,
//                      R7, R8). No `returns:` — interactive steps forbid it.
//   4. read-phases     command — cat the artifact; `parsePhases` validates it
//                      into an ordered list, halting on empty/malformed (R8).
//   5. per-phase loop  one interactive + autoStop implement step per phase,
//                      implement-only; a per-phase status sentinel halts the
//                      run before the next phase if the agent did not report
//                      success (R9).
//
// Phase logic lives ONLY here; both variants inherit any change. The decide
// and per-phase prompts are built from `decide-prompt.ts` constants so the
// emit format and the parser cannot drift.

import { command, type RunFn, step, type WorkflowExecutor, workflow } from '../../core/index.ts'
import type { Runner } from '../../runners/index.ts'
import { ARTIFACT_PATH, buildDecidePrompt } from './decide-prompt.ts'
import { type Phase, parsePhases } from './parse-phases.ts'

/** Per-phase status sentinel path. Mirrors the decide artifact pattern (U4). */
function sentinelPath(phaseNumber: number): string {
  return `.orch/phase-${phaseNumber}-status`
}

/**
 * Build the implement prompt for a single phase. Implement-only: the agent is
 * told NOT to commit and NOT to run project validation (R9 — orch cannot know
 * the host project's test/verify commands; the user owns those). The final
 * instruction is to write the status sentinel so the loop can detect failure.
 */
function buildImplementPrompt(
  phase: Phase,
  phaseNumber: number,
  total: number,
  statusPath: string,
): string {
  return [
    `Implement ONLY phase ${phaseNumber} of ${total} of a larger plan.`,
    '',
    `Phase ${phaseNumber}: ${phase.title}`,
    phase.description,
    '',
    'Work autonomously; do not ask questions. Implement only this phase and leave all',
    'later phases untouched. Do NOT create a commit, and do NOT run the project tests or',
    'any other project validation — the user owns commits and verification.',
    '',
    `As your final action, write your status to \`${statusPath}\`: the single word \`ok\` if`,
    `you completed this phase, or \`blocked: <reason>\` if you could not. Write \`${statusPath}\``,
    'before you end your turn so the pipeline can tell whether to continue.',
  ].join('\n')
}

/**
 * Resolve the workflow argument into plan text (R10, AE5). An existing,
 * readable file → its contents; anything else (inline description, directory,
 * unreadable path) → the argument string verbatim. Folds detect + load into
 * one cached, resumable `command` step. Relative paths resolve against the
 * command step's cwd (the active worktree if one is entered, else the workflow
 * cwd).
 */
async function resolveInput(run: RunFn, promptArg: string): Promise<string> {
  // `--` ends option parsing so a flag-shaped argument (e.g. `-n`) is always
  // treated as a filename, never as a `cat` option that would silently read
  // stdin and yield an empty plan.
  const cat = command('resolve-input', { argv: ['cat', '--', promptArg], onFailure: 'continue' })
  const result = await run(cat)
  if (result.exitCode === 0) return result.stdout

  // Non-zero ⇒ treat the argument as an inline description. But if it looks like
  // a path, the likelier cause is an unreadable/missing file than a genuine
  // inline description — warn so the user is not silently planning against the
  // literal path string.
  if (promptArg.includes('/')) {
    process.stderr.write(
      `orch: "${promptArg}" looks like a file path but could not be read ` +
        `(cat exit ${result.exitCode}); treating it as an inline description.\n`,
    )
  }
  return promptArg
}

/**
 * Run the decide step and read its artifact back into an ordered phase list.
 * The artifact is truncated BEFORE the decide step so a decide that writes
 * nothing yields an empty read → `parsePhases` throws → the run halts, rather
 * than a `cat` succeeding against a stale prior-run artifact (R-4).
 */
async function decidePhases(run: RunFn, runner: Runner, planText: string): Promise<Phase[]> {
  const truncate = command('truncate-phases', {
    argv: ['rm', '-f', ARTIFACT_PATH],
    onFailure: 'halt',
  })
  await run(truncate)

  const decide = step.define('decide-phases', {
    mode: 'interactive',
    autoStop: true,
    agent: runner,
    prompt: buildDecidePrompt(planText),
  })
  await run(decide)

  const readBack = command('read-phases', { argv: ['cat', ARTIFACT_PATH], onFailure: 'continue' })
  const artifact = await run(readBack)
  return parsePhases(artifact.stdout)
}

/**
 * Implement each phase in order, one interactive + autoStop step per phase.
 * A per-phase status sentinel (truncated before the step, read after) is the
 * explicit failure signal R9 needs: interactive autoStop steps always return
 * exitCode 0, so a missing/non-`ok` sentinel — not the exit code — is what
 * halts the loop before the next phase.
 */
async function runImplementLoop(
  run: RunFn,
  runner: Runner,
  phases: readonly Phase[],
): Promise<void> {
  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i]
    // Satisfies noUncheckedIndexedAccess; phases is a dense array, so a hole is
    // an invariant violation, not a phase to silently skip (which would mis-count
    // and quietly drop work).
    if (phase === undefined) throw new Error(`Invariant: phases[${i}] is undefined`)
    const phaseNumber = i + 1
    const statusPath = sentinelPath(phaseNumber)

    const truncateStatus = command(`truncate-status-${phaseNumber}`, {
      argv: ['rm', '-f', statusPath],
      onFailure: 'halt',
    })
    await run(truncateStatus)

    const implement = step.define('implement-phase', {
      mode: 'interactive',
      autoStop: true,
      agent: runner,
      prompt: buildImplementPrompt(phase, phaseNumber, phases.length, statusPath),
    })
    await run(implement, { as: `phase-${phaseNumber}` })

    const readStatus = command(`read-status-${phaseNumber}`, {
      argv: ['cat', statusPath],
      onFailure: 'continue',
    })
    const status = await run(readStatus)
    const reported = status.stdout.trim()
    if (reported !== 'ok') {
      throw new Error(
        `Phase ${phaseNumber} ("${phase.title}") did not report success — ` +
          `status sentinel ${statusPath} was ${reported === '' ? 'empty or missing' : `"${reported}"`}. ` +
          'Halting before the next phase rather than compounding the failure.',
      )
    }
  }
}

/**
 * Build a phased-build workflow bound to `runner`. `name` is supplied by the
 * caller (the entry modules) so `work-cc` and `work-codex` get distinct
 * workflow names while sharing this body verbatim.
 */
export function buildPhasedWorkflow(name: string, runner: Runner): WorkflowExecutor {
  return workflow(name, async (run, args) => {
    if (args.prompt === undefined || args.prompt.trim() === '') {
      throw new Error(
        `${name} requires a plan file or an inline description. ` +
          `Usage: orch run orch::${name} "<plan-file-or-description>"`,
      )
    }

    const planText = await resolveInput(run, args.prompt)
    if (planText.trim() === '') {
      throw new Error(
        `${name}: the resolved plan is empty. Provide a non-empty plan file or an inline description. ` +
          `Usage: orch run orch::${name} "<plan-file-or-description>"`,
      )
    }

    const phases = await decidePhases(run, runner, planText)
    await runImplementLoop(run, runner, phases)
  })
}
