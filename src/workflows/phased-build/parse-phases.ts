// ---------------------------------------------------------------------------
// parsePhases — deterministic read-back of the decide-phases artifact (R8)
// ---------------------------------------------------------------------------
//
// Pure, no LLM, no IO. Splits the artifact text on the shared `PHASE_DELIMITER`
// (from decide-prompt.ts, so prompt and parser cannot drift), trims, drops
// empty blocks, and returns an ordered `Phase[]`.
//
// Validation policy:
//   - zero well-formed blocks  → throw a clear, run-halting error (R8).
//   - more than 4 blocks       → warn, but return ALL blocks (soft cap,
//                                decision 3 — never truncate).
//
// A "well-formed" block has a required, non-empty title; the description is
// optional. Running this on the cached stdout of the read-back `command` step
// keeps it pure and safe to re-run on resume.

import { PHASE_DELIMITER } from './decide-prompt.ts'

export interface Phase {
  /** Required, non-empty one-line title. */
  readonly title: string
  /** Free-text description; may be empty. */
  readonly description: string
}

export interface ParsePhasesOptions {
  /** Sink for the >4-phase soft-cap warning. Defaults to `console.warn`. */
  readonly warn?: (message: string) => void
}

const SOFT_CAP = 4

/** Escape regex metacharacters so the delimiter is matched literally. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Matches a delimiter line on its own line, tolerating surrounding whitespace. */
const DELIMITER_LINE = new RegExp(`^[ \\t]*${escapeRegExp(PHASE_DELIMITER)}[ \\t]*$`, 'm')

export class PhaseParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PhaseParseError'
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/**
 * Parse the decide-phases artifact into an ordered phase list.
 *
 * @throws {PhaseParseError} when no well-formed phase block is present — this
 *   halts the run rather than letting an empty/malformed artifact drive an
 *   implementation loop with zero phases.
 */
export function parsePhases(text: string, opts: ParsePhasesOptions = {}): Phase[] {
  // Drop the preamble (anything before the first delimiter) and split into
  // one segment per phase block.
  const segments = text.split(DELIMITER_LINE).slice(1)

  const phases: Phase[] = []
  for (const segment of segments) {
    const lines = segment.split(/\r?\n/)
    const titleIndex = lines.findIndex((line) => line.trim().length > 0)
    if (titleIndex === -1) continue // empty block — tolerate and drop

    const title = (lines[titleIndex] ?? '').trim()
    const description = lines
      .slice(titleIndex + 1)
      .join('\n')
      .trim()
    phases.push({ title, description })
  }

  if (phases.length === 0) {
    throw new PhaseParseError(
      `decide-phases produced no well-formed phases. Expected at least one "${PHASE_DELIMITER}" ` +
        'block with a non-empty title. The run is halted rather than proceeding with zero phases.',
    )
  }

  if (phases.length > SOFT_CAP) {
    const warn = opts.warn ?? ((message: string) => console.warn(message))
    warn(
      `decide-phases emitted ${phases.length} phases (soft cap is ${SOFT_CAP}). ` +
        'Proceeding with all of them — consider whether the work could be split more coarsely.',
    )
  }

  return phases
}
