import { describe, expect, it } from 'bun:test'
import { ChangelogError, extractSection } from '../../../scripts/changelog-section.ts'

const FINAL = `# Changelog

## [0.2.0] - 2026-07-01

Headline summary for 0.2.0.

### Features

- a feature

## [0.1.0] - 2026-06-09

First release summary.

### Features

- the binary
`

describe('extractSection', () => {
  it('returns the heading and body for a finalised entry', () => {
    const section = extractSection(FINAL, '0.2.0')

    expect(section.heading).toBe('## [0.2.0] - 2026-07-01')
    expect(section.body).toContain('Headline summary for 0.2.0.')
    expect(section.body).toContain('- a feature')
    // Stops at the next ## heading — does not bleed into 0.1.0.
    expect(section.body).not.toContain('First release summary.')
  })

  it('accepts a bare `## X.Y.Z` heading form too', () => {
    const section = extractSection('# Changelog\n\n## 1.0.0\n\nbody line\n', '1.0.0')

    expect(section.body).toBe('body line')
  })

  it('throws when the version has no entry', () => {
    expect(() => extractSection(FINAL, '9.9.9')).toThrow(/no entry for version 9\.9\.9/)
  })

  it('rejects an XX placeholder date (the U3 seed before the operator finalises it)', () => {
    const seed = '# Changelog\n\n## [0.1.0] - 2026-XX-XX\n\nsome body\n'

    expect(() => extractSection(seed, '0.1.0')).toThrow(ChangelogError)
    expect(() => extractSection(seed, '0.1.0')).toThrow(/placeholder date/)
  })

  it('rejects an entry with an empty body (a bare stub heading)', () => {
    const stub = '# Changelog\n\n## [0.1.0] - 2026-06-09\n\n## [0.0.9] - 2026-01-01\n\nold\n'

    expect(() => extractSection(stub, '0.1.0')).toThrow(/empty body/)
  })
})
