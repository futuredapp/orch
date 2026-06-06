// MIGRATED → tests-new/unit/core/workflow-name-validation.test.ts (parent U10) — relocated verbatim (import paths only); kept skipped on disk (D2).
// Runtime tests for U2 — workflow name validation and module-private body
// handle. The compile-time generic-typing scenarios live in
// `workflow-typing.test-d.ts`; this file covers behaviors that need real
// values rather than just types.

import { describe, expect, it } from 'bun:test'
import { bodyHandle, workflow } from '../../../src/core/workflow.ts'

describe.skip('workflow() name validation', () => {
  it('accepts names matching the existing alphabet', () => {
    expect(() => workflow('simple-feature', async () => {})).not.toThrow()
    expect(() => workflow('s', async () => {})).not.toThrow()
    expect(() => workflow('a1b2-c3', async () => {})).not.toThrow()
  })

  it('rejects a name containing the sub-path separator `>`', () => {
    expect(() => workflow('foo>bar', async () => {})).toThrow(/workflow name must match/)
  })

  it('rejects a name containing the vars-hash separator `:`', () => {
    expect(() => workflow('foo:bar', async () => {})).toThrow(/workflow name must match/)
  })

  it('rejects an empty name', () => {
    expect(() => workflow('', async () => {})).toThrow(/workflow name must match/)
  })

  it('rejects a name starting with a hyphen', () => {
    expect(() => workflow('-foo', async () => {})).toThrow(/workflow name must match/)
  })

  it('rejects a name containing uppercase characters', () => {
    expect(() => workflow('Foo', async () => {})).toThrow(/workflow name must match/)
  })

  it('rejects a name containing whitespace', () => {
    expect(() => workflow('foo bar', async () => {})).toThrow(/workflow name must match/)
  })

  it('quotes the offending name in the error message', () => {
    expect(() => workflow('foo>bar', async () => {})).toThrow(/"foo>bar"/)
  })
})

describe.skip('workflow() body handle', () => {
  it('hides the symbol-keyed body from Object.keys', () => {
    const executor = workflow('hidden', async () => {})

    expect(Object.keys(executor)).toEqual(expect.arrayContaining(['name']))
    expect(Object.keys(executor)).not.toContain(bodyHandle.toString())
    // Symbol-keyed members never appear in Object.keys regardless.
    expect(Object.keys(executor).some((k) => typeof k === 'symbol')).toBe(false)
  })

  it('hides the symbol-keyed body from for...in enumeration', () => {
    const executor = workflow('hidden2', async () => {})

    const keys: (string | symbol)[] = []
    for (const k in executor) keys.push(k)
    expect(keys).not.toContain(bodyHandle as unknown as string)
  })

  it('exposes the body to readers that hold the symbol', () => {
    const body = async () => {}
    const executor = workflow('exposed', body)

    expect(executor[bodyHandle]).toBe(body)
  })

  it('preserves the typed body identity across the executor wrapper', () => {
    let observed: unknown = null
    const body = async (_run: unknown, args: unknown) => {
      observed = args
    }
    const executor = workflow('identity', body)

    // Pull the body back out and invoke it directly — same function, same
    // contract. This is the seam runWorkflow uses.
    void executor[bodyHandle](null as never, { prompt: 'hi' })
    expect(observed).toEqual({ prompt: 'hi' })
  })
})
