import { describe, expect, it } from 'bun:test'
import { makeFlagGuard } from '../../../src/runners/flag-guard.ts'

describe('makeFlagGuard', () => {
  it('throws for a bare denylisted flag', () => {
    const guard = makeFlagGuard('x', ['--settings'])

    expect(() => guard('--settings')).toThrow(/flag "--settings" is on the denylist/)
  })

  it('throws for a denylisted flag in --flag=value form (prefix match)', () => {
    const guard = makeFlagGuard('x', ['--settings'])

    expect(() => guard('--settings=/tmp/evil.json')).toThrow(
      /flag "--settings=\/tmp\/evil.json" is on the denylist/,
    )
  })

  it('does not throw for a flag that is not on the denylist', () => {
    const guard = makeFlagGuard('x', ['--settings'])

    expect(() => guard('--model')).not.toThrow()
  })

  it('does not match a flag that merely shares a prefix without a = separator', () => {
    const guard = makeFlagGuard('x', ['--settings'])

    expect(() => guard('--settings-extra')).not.toThrow()
  })

  it('prefixes the error message with the runner name it was built with', () => {
    const guard = makeFlagGuard('codex', ['--config'])

    expect(() => guard('--config')).toThrow(/^codex\(\): flag "--config" is on the denylist/)
  })
})
