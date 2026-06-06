// MIGRATED → tests-new/unit/core/derive-step-key.test.ts (parent U10) — relocated verbatim (import paths only); kept skipped on disk (D2).
// U4 — sub-aware cache key derivation. Exercises `deriveStepKey` directly so
// the fold rules (`as:` wins, sub-path prefix, vars-hash suffix) are pinned
// independently of the rest of `runStepOnce`.

import { describe, expect, it } from 'bun:test'
import { stableHashHex } from '../../../src/core/prompt-file/cache-key.ts'
import { stepName } from '../../../src/core/types.ts'
import { deriveStepKey } from '../../../src/core/workflow.ts'

describe.skip('deriveStepKey — sub-aware folding', () => {
  it('returns the bare name when subPath is empty and no overrides', () => {
    expect(deriveStepKey(stepName('plan'), undefined)).toBe('plan')
  })

  it('returns the bare name when subPath is empty (explicit empty array)', () => {
    expect(deriveStepKey(stepName('plan'), undefined, [])).toBe('plan')
  })

  it('prepends the single sub-path segment as a `>`-joined prefix', () => {
    expect(deriveStepKey(stepName('plan'), undefined, ['simple-feature'])).toBe(
      'simple-feature>plan',
    )
  })

  it('joins multiple sub-path segments with `>` and ends in the step name', () => {
    expect(deriveStepKey(stepName('plan'), undefined, ['outer', 'inner'])).toBe('outer>inner>plan')
  })

  it('lets `as:` override bypass sub-folding entirely (legacy flat key)', () => {
    expect(deriveStepKey(stepName('plan'), { as: 'override' }, ['simple-feature'])).toBe('override')
    expect(deriveStepKey(stepName('plan'), { as: 'override' }, ['outer', 'inner'])).toBe('override')
  })

  it('appends the vars-hash suffix AFTER the sub-path prefix', () => {
    const expectedHash = stableHashHex({ x: 'hi' })
    expect(deriveStepKey(stepName('plan'), { vars: { x: 'hi' } }, ['outer'])).toBe(
      `outer>plan:vars-${expectedHash}`,
    )
  })

  it('omits the vars suffix when vars is empty even inside a sub', () => {
    expect(deriveStepKey(stepName('plan'), { vars: {} }, ['outer'])).toBe('outer>plan')
  })

  it('keys two same-named steps in different subs to different cache keys', () => {
    // Regression for the 2026-05-31 "decide-cached, reroute to different sub"
    // hazard. The same step name `plan` invoked in two different subs MUST
    // produce two distinct cache keys; otherwise a cached value from one
    // sub would silently replay into the other.
    const k1 = deriveStepKey(stepName('plan'), undefined, ['simple-feature'])
    const k2 = deriveStepKey(stepName('plan'), undefined, ['complex-feature'])
    expect(k1).not.toBe(k2)
    expect(k1).toBe('simple-feature>plan')
    expect(k2).toBe('complex-feature>plan')
  })
})
