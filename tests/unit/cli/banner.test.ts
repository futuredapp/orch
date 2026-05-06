// Banner / hint tests for `orch run` startup output (PR B).
//
// `buildBanner` is the existing one-liner that names the resolved mode and
// where it came from; `buildTwoPaneLogsHint` (PR B) adds a second line in
// two-pane non-JSON runs that points the user at `orch logs --latest
// --follow --step <step-name>`. The hint is the load-bearing replacement
// for the wheel-into-copy-mode discoverability that the strict sandbox
// removed (plan AD-9).

import { describe, expect, it } from 'bun:test'
import { buildBanner, buildTwoPaneLogsHint } from '../../../src/cli/main.ts'
import type { RunModeResolution } from '../../../src/core/index.ts'

const resolution = (mode: RunModeResolution['mode']): RunModeResolution => ({
  mode,
  source: 'flag',
  reason: '--mode override',
})

describe('buildBanner', () => {
  it('renders the resolved mode, source, and reason on a single line', () => {
    const out = buildBanner(resolution('two-pane'))

    expect(out).toContain('mode=two-pane')
    expect(out).toContain('flag')
    expect(out).toContain('--mode override')
  })
})

describe('buildTwoPaneLogsHint', () => {
  it('returns the orch logs hint for two-pane non-JSON runs', () => {
    const out = buildTwoPaneLogsHint(resolution('two-pane'), 'text')

    expect(out).toBeDefined()
    expect(out).toContain('orch logs --latest --follow')
  })

  it('returns undefined for plain runs because plain prints the transcript inline', () => {
    expect(buildTwoPaneLogsHint(resolution('plain'), 'text')).toBeUndefined()
  })

  it('returns undefined for two-pane JSON runs because JSON suppresses the banner entirely', () => {
    expect(buildTwoPaneLogsHint(resolution('two-pane'), 'json')).toBeUndefined()
  })
})
