// Pins the load-bearing property of the addressing transport: encodeKey is
// injective (R10). Distinct logical keys MUST map to distinct filename stems,
// or two instances silently share a control file and per-instance / per-run
// isolation breaks.

import { describe, expect, it } from 'bun:test'
import {
  controlPathsForControlFile,
  encodeKey,
  resolveControlPaths,
} from '../../../../src/runners/scripted-fake/index.ts'

describe('encodeKey — injectivity (R10)', () => {
  it('maps the cache-key separators > and : to distinct stems', () => {
    expect(encodeKey('a>b')).not.toBe(encodeKey('a:b'))
  })

  it('leaves filesystem-safe characters untouched', () => {
    expect(encodeKey('plan_step-2.v1')).toBe('plan_step-2.v1')
  })

  it('does not collide a control char with an adjacent literal (fixed-width hex)', () => {
    // With variable-width hex, U+0001 + "0" ("%1" + "0") and U+0010 ("%10")
    // would both encode to "%10"; fixed 4-digit hex keeps them apart.
    const u0001Then0 = `${String.fromCharCode(0x01)}0`
    const u0010 = String.fromCharCode(0x10)

    expect(encodeKey(u0001Then0)).not.toBe(encodeKey(u0010))
  })

  it('encodes % itself so a raw key cannot forge an escape token', () => {
    // "%0041" is the encoding of "A"; encoding the literal "%" first stops the
    // raw key "%0041" from colliding with the key "A".
    expect(encodeKey('%0041')).not.toBe(encodeKey('A'))
  })

  it('never leaks > or : into the encoded stem', () => {
    const encoded = encodeKey('outer>plan:vars-abc')
    expect(encoded).not.toContain('>')
    expect(encoded).not.toContain(':')
  })
})

describe('resolveControlPaths / controlPathsForControlFile', () => {
  it('derives the .acks and .ready siblings from the key under test-control', () => {
    const paths = resolveControlPaths({ runStateDir: '/base/run-1', key: 's1' })

    expect(paths.controlPath).toBe('/base/run-1/test-control/s1.ndjson')
    expect(paths.ackDir).toBe('/base/run-1/test-control/s1.ndjson.acks')
    expect(paths.readyPath).toBe('/base/run-1/test-control/s1.ready')
    expect(paths.renderLogPath).toBe('/base/run-1/test-control/s1.render')
  })

  it('derives the same sibling layout from a baked control file path', () => {
    const paths = controlPathsForControlFile('/legacy/plan.ndjson')

    expect(paths.controlDir).toBe('/legacy')
    expect(paths.ackDir).toBe('/legacy/plan.ndjson.acks')
    expect(paths.readyPath).toBe('/legacy/plan.ready')
  })
})
