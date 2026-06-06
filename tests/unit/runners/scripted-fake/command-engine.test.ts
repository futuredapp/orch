// MIGRATED → tests-new/unit/runners/scripted-fake/command-engine.test.ts (parent U11) — relocated verbatim (import paths only); kept skipped on disk (D2).
// U2 — the shared command engine. The engine is pure: it maps both channels
// (control NDJSON + manual stdin) onto the same two-op vocabulary
// (`type_and_send` / `finish`) and routes ops to a mode-injected sink. These
// tests use a recording sink so the cross-mode / cross-channel guarantees are
// asserted without any I/O.

import { describe, expect, it } from 'bun:test'
import {
  controlToEngineOp,
  type EngineOp,
  type OutputSink,
  parseControlLine,
  parseManualLine,
  runEngineOp,
} from '../../../../src/runners/scripted-fake/index.ts'

interface RecordingSink extends OutputSink {
  readonly lines: string[]
  readonly finishes: number[]
}

function recordingSink(): RecordingSink {
  const lines: string[] = []
  const finishes: number[] = []
  return {
    lines,
    finishes,
    typeLine: (text: string) => {
      lines.push(text)
    },
    finish: (code: number) => {
      finishes.push(code)
    },
  }
}

describe.skip('U2 — runEngineOp applies ops to the injected sink', () => {
  it('appends exactly one line for a non-empty type_and_send and continues', () => {
    const sink = recordingSink()

    const result = runEngineOp({ op: 'type_and_send', text: 'hello' }, sink)

    expect(sink.lines).toEqual(['hello'])
    expect(result).toEqual({ kind: 'continue' })
  })

  it('treats an empty type_and_send as a no-op in the sink (R3 mode parity)', () => {
    const sink = recordingSink()

    const result = runEngineOp({ op: 'type_and_send', text: '' }, sink)

    expect(sink.lines).toEqual([])
    expect(result).toEqual({ kind: 'continue' })
  })

  it('terminates with the default code 0 on finish()', () => {
    const sink = recordingSink()

    const result = runEngineOp({ op: 'finish', code: 0 }, sink)

    expect(sink.finishes).toEqual([0])
    expect(result).toEqual({ kind: 'terminate', exitCode: 0 })
  })

  it('terminates with the supplied non-zero code on finish(2)', () => {
    const sink = recordingSink()

    const result = runEngineOp({ op: 'finish', code: 2 }, sink)

    expect(sink.finishes).toEqual([2])
    expect(result).toEqual({ kind: 'terminate', exitCode: 2 })
  })
})

describe.skip('U2 — parseManualLine maps stdin to the vocabulary (R5)', () => {
  it('parses a bare line to type_and_send of that exact text (AE1)', () => {
    expect(parseManualLine('hello')).toEqual({ op: 'type_and_send', text: 'hello' })
  })

  it('parses literal q and literal exit each to finish (AE2)', () => {
    expect(parseManualLine('q')).toEqual({ op: 'finish', code: 0 })
    expect(parseManualLine('exit')).toEqual({ op: 'finish', code: 0 })
  })

  it('ignores an empty line and a whitespace-only line (no op)', () => {
    expect(parseManualLine('')).toBeNull()
    expect(parseManualLine('   ')).toBeNull()
  })

  it('treats a quit word with trailing space as finish (trim-based)', () => {
    expect(parseManualLine('q ')).toEqual({ op: 'finish', code: 0 })
  })

  it('keeps a line that merely starts with q as type_and_send', () => {
    expect(parseManualLine('q hello')).toEqual({ op: 'type_and_send', text: 'q hello' })
  })
})

describe.skip('U2 — control and manual channels produce identical engine ops (R3)', () => {
  it('control type_and_send and a manual bare line yield the same op', () => {
    const control = parseControlLine(JSON.stringify({ cmd: 'type_and_send', text: 'hi' }))
    const controlOp = control.kind === 'ok' ? controlToEngineOp(control.value) : null

    const manualOp = parseManualLine('hi')

    const expected: EngineOp = { op: 'type_and_send', text: 'hi' }
    expect(controlOp).toEqual(expected)
    expect(manualOp).toEqual(expected)
  })

  it('control finish and a manual q yield the same op', () => {
    const control = parseControlLine(JSON.stringify({ cmd: 'finish' }))
    const controlOp = control.kind === 'ok' ? controlToEngineOp(control.value) : null

    const manualOp = parseManualLine('q')

    const expected: EngineOp = { op: 'finish', code: 0 }
    expect(controlOp).toEqual(expected)
    expect(manualOp).toEqual(expected)
  })

  it('propagates an explicit finish code from the control channel', () => {
    const control = parseControlLine(JSON.stringify({ cmd: 'finish', code: 3 }))

    const op = control.kind === 'ok' ? controlToEngineOp(control.value) : null

    expect(op).toEqual({ op: 'finish', code: 3 })
  })
})

describe.skip('U2 — control parsing tolerates bad input (R4)', () => {
  it('returns an error result for malformed JSON without throwing', () => {
    const result = parseControlLine('{not json')

    expect(result.kind).toBe('error')
  })

  it('returns an error result for a schema-invalid command without throwing', () => {
    const result = parseControlLine(JSON.stringify({ cmd: 'nonsense' }))

    expect(result.kind).toBe('error')
  })

  it('maps a legacy command to no engine op (handled by the entry directly)', () => {
    const control = parseControlLine(JSON.stringify({ cmd: 'wait', ms: 10 }))

    const op = control.kind === 'ok' ? controlToEngineOp(control.value) : 'parse-failed'

    expect(op).toBeNull()
  })
})
