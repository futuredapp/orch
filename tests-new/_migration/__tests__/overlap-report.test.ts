import { describe, expect, it } from 'bun:test'
import { analyze, parseScenarios, type ScenarioRef } from '../overlap-report.ts'

// Unit tests for the overlap report over FIXTURE inputs (not the live tree).
// They prove the two findings classes (missing twin, unknown old ref) and the
// load-bearing import-time-purity property: the report parses source TEXT and
// never imports/evaluates a scenario file, so it registers ZERO Bun tests
// (parent §5.3 / D-P3.6 / risk P3-B).

const BASELINE = new Set<string>([
  'tests/integration/hosts/two-pane/tier-1/follow-live-returns.real.integration.test.ts',
  'tests/e2e/tier-4/autonomous-multi-step.real.e2e.test.ts',
])

function modelScenario(group: string): string {
  return `
    import { scenario } from '../dsl/index.ts'
    scenario({
      name: 'model member',
      feature: 'follow-live',
      drivers: ['model'],
      overlapGroup: '${group}',
      oldTestRefs: ['tests/integration/hosts/two-pane/tier-1/follow-live-returns.real.integration.test.ts'],
    }, async (app) => { await app.leftPane.assertStepSelected('execute') })
  `
}

function screenScenario(group: string): string {
  return `
    import { scenario } from '../dsl/index.ts'
    scenario({
      name: 'screen twin',
      feature: 'follow-live',
      drivers: ['screen'],
      overlapGroup: '${group}',
      oldTestRefs: [],
    }, async (app) => { await app.leftPane.assertQuitHintVisible() })
  `
}

describe('overlap report — missing model↔screen twin', () => {
  it('flags an overlap group with a model member but no real-tmux twin', () => {
    const scenarios = parseScenarios(modelScenario('follow-live-view-mode'), 'model/x.test.ts')

    const findings = analyze(scenarios, BASELINE)

    expect(findings.missingTwins).toHaveLength(1)
    expect(findings.missingTwins[0]?.overlapGroup).toBe('follow-live-view-mode')
  })

  it('passes when the group has both a model member and a screen twin', () => {
    const scenarios: ScenarioRef[] = [
      ...parseScenarios(modelScenario('follow-live-view-mode'), 'model/x.test.ts'),
      ...parseScenarios(screenScenario('follow-live-view-mode'), 'screen/y.test.ts'),
    ]

    const findings = analyze(scenarios, BASELINE)

    expect(findings.missingTwins).toHaveLength(0)
  })
})

describe('overlap report — unknown old ref vs the frozen baseline (D12)', () => {
  it('flags an oldTestRefs entry absent from the baseline', () => {
    const source = `
      import { scenario } from '../dsl/index.ts'
      scenario({
        name: 'orphan ref',
        feature: 'x',
        drivers: ['model'],
        oldTestRefs: ['tests/does/not/exist.test.ts'],
      }, async () => {})
    `
    const scenarios = parseScenarios(source, 'model/z.test.ts')

    const findings = analyze(scenarios, BASELINE)

    expect(findings.unknownOldRefs).toHaveLength(1)
    expect(findings.unknownOldRefs[0]?.ref).toBe('tests/does/not/exist.test.ts')
  })

  it('passes when every oldTestRefs entry resolves (incl. a directory prefix)', () => {
    const source = `
      import { scenario } from '../dsl/index.ts'
      scenario({
        name: 'real refs',
        feature: 'x',
        drivers: ['full-host:real-agent'],
        oldTestRefs: ['tests/e2e/tier-4'],
      }, async () => {})
    `
    const scenarios = parseScenarios(source, 'full-host/real-agent/a.test.ts')

    const findings = analyze(scenarios, BASELINE)

    expect(findings.unknownOldRefs).toHaveLength(0)
  })
})

describe('overlap report — import-time purity (parent §5.3)', () => {
  it('parses scenario metadata from source that would THROW on import, registering no tests', () => {
    // If the report `import`ed this source, the top-level throw would blow up and
    // the `it()` would register a Bun test. parseScenarios is text-only, so it
    // returns the scenario meta and fires nothing.
    const hostile = `
      throw new Error('this module must never be imported by the report')
      import { scenario } from '../dsl/index.ts'
      it('a stray bun test that must not register', () => { throw new Error('ran!') })
      scenario({
        name: 'parsed without evaluating',
        feature: 'x',
        drivers: ['model'],
        oldTestRefs: [],
      }, async () => {})
    `

    const scenarios = parseScenarios(hostile, 'model/hostile.test.ts')

    expect(scenarios).toHaveLength(1)
    expect(scenarios[0]?.name).toBe('parsed without evaluating')
  })
})
