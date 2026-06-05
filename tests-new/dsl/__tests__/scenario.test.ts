import { describe, expect, it } from 'bun:test'
import { canRunRealTmux } from '@orch/test/real-tmux/index.ts'
import { expandScenario } from '../scenario.ts'

// `expandScenario` is the pure core of `scenario()`: it maps a scenario's meta
// to the cases it would register, without registering any test or building any
// driver. Asserting on it lets us prove the expansion contract deterministically
// instead of reaching into Bun's test registry.

describe('expandScenario maps a scenario to one case per listed driver', () => {
  it('expands a single-driver scenario to exactly one case labelled "name [driver]"', () => {
    const cases = expandScenario({
      name: 'pressing follow-live returns to the running step',
      drivers: ['model'],
      feature: 'follow-live',
      oldTestRefs: [],
    })

    expect(cases).toHaveLength(1)
    expect(cases[0]?.label).toBe('pressing follow-live returns to the running step [model]')
    expect(cases[0]?.driverName).toBe('model')
  })

  it('expands a two-driver scenario to two cases, one per driver, in order', () => {
    const cases = expandScenario({
      name: 'the footer renders the quit hint',
      drivers: ['model', 'screen'],
      feature: 'follow-live',
      oldTestRefs: [],
    })

    expect(cases.map((c) => c.driverName)).toEqual(['model', 'screen'])
    expect(cases.map((c) => c.label)).toEqual([
      'the footer renders the quit hint [model]',
      'the footer renders the quit hint [screen]',
    ])
  })
})

describe('expandScenario reflects each driver capability predicate', () => {
  it('marks the live model driver as not skipped', () => {
    const cases = expandScenario({
      name: 'a model behaviour',
      drivers: ['model'],
      feature: 'demo',
      oldTestRefs: [],
    })

    expect(cases[0]?.skip).toBe(false)
  })

  it('reflects a real tmux driver capability predicate (no stubs remain after U3)', () => {
    // Every driver is live after parent U3 — `full-host:recorded-agent` is a
    // real driver whose predicate skips only when real tmux is unavailable (D8),
    // never because it is unimplemented. The skip tracks capability, not a stub.
    const cases = expandScenario({
      name: 'a recorded-agent behaviour',
      drivers: ['full-host:recorded-agent'],
      feature: 'demo',
      oldTestRefs: [],
    })

    expect(cases[0]?.skip).toBe(!canRunRealTmux())
  })
})
