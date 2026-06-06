import { describe, expect, it } from 'bun:test'
import {
  ARTIFACT_PATH,
  PHASE_DELIMITER,
} from '../../../src/workflows/phased-build/decide-prompt.ts'
import { PhaseParseError, parsePhases } from '../../../src/workflows/phased-build/parse-phases.ts'

function block(title: string, description = ''): string {
  return `${PHASE_DELIMITER}\n${title}${description ? `\n${description}` : ''}`
}

describe('parsePhases — well-formed artifacts (AE4)', () => {
  it('returns a single phase for a one-block artifact without padding it', () => {
    const text = block('Wire the resolver', 'Add the orch:: branch')

    const phases = parsePhases(text)

    expect(phases).toHaveLength(1)
    expect(phases[0]).toEqual({ title: 'Wire the resolver', description: 'Add the orch:: branch' })
  })

  it('returns N phases in source order for an N-block artifact', () => {
    const text = [block('First', 'do a'), block('Second', 'do b'), block('Third', 'do c')].join(
      '\n',
    )

    const phases = parsePhases(text)

    expect(phases.map((p) => p.title)).toEqual(['First', 'Second', 'Third'])
  })

  it('treats the description as optional, returning an empty string when absent', () => {
    const text = block('Title only')

    const phases = parsePhases(text)

    expect(phases[0]).toEqual({ title: 'Title only', description: '' })
  })

  it('preserves a multi-line description verbatim', () => {
    const text = block('Phase', 'line one\nline two\nline three')

    const phases = parsePhases(text)

    expect(phases[0]?.description).toBe('line one\nline two\nline three')
  })
})

describe('parsePhases — soft cap above four (decision 3)', () => {
  it('returns all blocks and emits a warning when more than four phases parse', () => {
    const warnings: string[] = []
    const text = [block('p1'), block('p2'), block('p3'), block('p4'), block('p5')].join('\n')

    const phases = parsePhases(text, { warn: (m) => warnings.push(m) })

    expect(phases).toHaveLength(5)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('5 phases')
  })

  it('does not warn at exactly four phases', () => {
    const warnings: string[] = []
    const text = [block('p1'), block('p2'), block('p3'), block('p4')].join('\n')

    parsePhases(text, { warn: (m) => warnings.push(m) })

    expect(warnings).toHaveLength(0)
  })
})

describe('parsePhases — validation halts on empty or malformed input (R8)', () => {
  it('throws PhaseParseError on an empty string', () => {
    expect(() => parsePhases('')).toThrow(PhaseParseError)
  })

  it('throws PhaseParseError on whitespace-only input', () => {
    expect(() => parsePhases('   \n\t\n  ')).toThrow(PhaseParseError)
  })

  it('throws when the delimiter is present but every block is empty', () => {
    const text = `${PHASE_DELIMITER}\n\n${PHASE_DELIMITER}\n   \n`

    expect(() => parsePhases(text)).toThrow(PhaseParseError)
  })

  it('throws when there is text but no delimiter at all', () => {
    expect(() => parsePhases('just some prose with no phase markers')).toThrow(PhaseParseError)
  })
})

describe('parsePhases — robustness of the deterministic format', () => {
  it('ignores a preamble before the first delimiter', () => {
    const text = `some notes the agent wrote first\n${block('Real phase', 'body')}`

    const phases = parsePhases(text)

    expect(phases).toHaveLength(1)
    expect(phases[0]?.title).toBe('Real phase')
  })

  it('tolerates a trailing delimiter with no block after it', () => {
    const text = `${block('Only phase', 'body')}\n${PHASE_DELIMITER}\n`

    const phases = parsePhases(text)

    expect(phases).toHaveLength(1)
  })

  it('tolerates blank lines between the delimiter and the title', () => {
    const text = `${PHASE_DELIMITER}\n\n\nDelayed title\n\nbody`

    const phases = parsePhases(text)

    expect(phases[0]).toEqual({ title: 'Delayed title', description: 'body' })
  })

  it('tolerates surrounding whitespace on the delimiter line', () => {
    const text = `   ${PHASE_DELIMITER}   \nTitle\nbody`

    const phases = parsePhases(text)

    expect(phases[0]?.title).toBe('Title')
  })

  it('parses an artifact written with CRLF line endings', () => {
    const text = `${PHASE_DELIMITER}\r\nCRLF title\r\nfirst body line\r\nsecond body line`

    const phases = parsePhases(text)

    expect(phases).toHaveLength(1)
    expect(phases[0]).toEqual({
      title: 'CRLF title',
      description: 'first body line\nsecond body line',
    })
  })
})

describe('decide-prompt — shared format contract', () => {
  it('exposes a fixed artifact path under .orch/', () => {
    expect(ARTIFACT_PATH).toBe('.orch/phased-build-phases.md')
  })
})
