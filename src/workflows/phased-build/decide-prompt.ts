// ---------------------------------------------------------------------------
// decide-phases — prompt text + the emit/parse format contract (R8)
// ---------------------------------------------------------------------------
//
// The decide step is interactive (no `returns:` is allowed on interactive
// steps), so the agent communicates its phase breakdown by WRITING a file
// rather than returning typed JSON. The delimiter and the artifact path are
// the contract between the prompt (what the agent is told to write) and
// `parse-phases.ts` (what the deterministic read-back parses). They live here,
// in one module, so the two sides cannot drift.

/** Line that separates one phase block from the next in the artifact. */
export const PHASE_DELIMITER = '=== PHASE ==='

/**
 * Fixed `.orch/`-relative path the decide step writes and the read-back reads.
 * `.orch/` is guaranteed to exist (the run requires `orch init`). Combined with
 * the truncate-before-decide guard in the pipeline, a fixed path is safe for
 * sequential single-user runs; run-scoped pathing for concurrent same-cwd runs
 * is deferred (see the plan's Deferred to Follow-Up Work).
 */
export const ARTIFACT_PATH = '.orch/phased-build-phases.md'

/**
 * Build the decide-phases prompt for a resolved plan/description.
 *
 * The agent is told to (1) re-derive its own phase breakdown sized to THIS run,
 * (2) bias toward few phases (1–4 for ordinary work), and (3) write the result
 * to `ARTIFACT_PATH` in the delimiter format before ending its turn — autoStop
 * closes the pane on turn-complete, so an unfinished write would be lost.
 *
 * R6: the prompt forbids mechanically copying any pre-written phase structure
 * present in the input. "Fresh" means re-derived, not blind — the input is
 * unavoidably visible, but its structure is evidence of complexity, not a
 * breakdown to reproduce.
 */
export function buildDecidePrompt(planText: string): string {
  return [
    'You are planning how to break a piece of work into sequential implementation phases.',
    '',
    'Analyze the work described below. Decide how many phases it should be split into,',
    'using a complexity heuristic: how many distinct changes, and how many unrelated',
    'concerns, does it touch? Bias strongly toward FEWER phases. For ordinary work, choose',
    'between 1 and 4 phases. Reserve more than 4 only for genuinely exceptional complexity.',
    'A small, single-concern change is ONE phase — do not pad it.',
    '',
    'Decide your own breakdown sized to THIS run. If the work below already contains a',
    'written phase structure, treat it only as evidence of complexity — do NOT mechanically',
    'reproduce it. Re-derive the breakdown yourself.',
    '',
    `When you have decided, write the breakdown to \`${ARTIFACT_PATH}\` using exactly this format,`,
    'one block per phase, the delimiter line on its own line before each phase:',
    '',
    PHASE_DELIMITER,
    '<one-line phase title>',
    '<free-text description of what this phase implements; may span multiple lines>',
    PHASE_DELIMITER,
    '<next phase title>',
    '<next phase description>',
    '',
    `Finish writing \`${ARTIFACT_PATH}\` completely before you end your turn. Do not implement`,
    'anything yet — this step only decides the phases.',
    '',
    '--- WORK TO BREAK INTO PHASES ---',
    planText,
  ].join('\n')
}
