// MIGRATED → tests-new/unit/hosts/terminal-reset.test.ts (parent U12) — relocated verbatim (import paths only); kept skipped on disk (D2).
import { describe, expect, it } from 'bun:test'
import { PassThrough } from 'node:stream'
import {
  restoreTerminalModes,
  TERMINAL_RESET_SEQUENCES,
} from '../../../src/hosts/two-pane/terminal-reset.ts'

// A minimal `WritableStream` wrapper with a configurable `isTTY` flag so we
// can exercise both the TTY and non-TTY branches without touching the real
// process.stdout.
function makeStream(isTTY: boolean): { stream: NodeJS.WritableStream; buffer: Buffer[] } {
  const pt = new PassThrough()
  ;(pt as unknown as { isTTY?: boolean }).isTTY = isTTY
  const buffer: Buffer[] = []
  pt.on('data', (chunk: Buffer) => buffer.push(chunk))
  return { stream: pt as unknown as NodeJS.WritableStream, buffer }
}

describe.skip('restoreTerminalModes', () => {
  it('writes the canonical DEC private-mode reset string when the stream is a TTY', () => {
    const { stream, buffer } = makeStream(true)

    restoreTerminalModes(stream)

    const written = Buffer.concat(buffer).toString('utf8')
    expect(written).toBe(TERMINAL_RESET_SEQUENCES)
  })

  it('disables every mouse-tracking variant so SGR reports cannot leak into the outer shell', () => {
    const { stream, buffer } = makeStream(true)

    restoreTerminalModes(stream)

    const written = Buffer.concat(buffer).toString('utf8')
    expect(written).toContain('\x1b[?1000l')
    expect(written).toContain('\x1b[?1002l')
    expect(written).toContain('\x1b[?1003l')
    expect(written).toContain('\x1b[?1005l')
    expect(written).toContain('\x1b[?1006l')
  })

  it('exits the alternate screen and turns bracketed paste off so prompts redraw cleanly', () => {
    const { stream, buffer } = makeStream(true)

    restoreTerminalModes(stream)

    const written = Buffer.concat(buffer).toString('utf8')
    expect(written).toContain('\x1b[?1049l')
    expect(written).toContain('\x1b[?2004l')
    expect(written).toContain('\x1b[?1l')
  })

  it('writes nothing when the stream is not a TTY so piped output stays clean', () => {
    const { stream, buffer } = makeStream(false)

    restoreTerminalModes(stream)

    expect(buffer).toHaveLength(0)
  })

  it('writes nothing when the stream has no isTTY property at all', () => {
    const pt = new PassThrough()
    const buffer: Buffer[] = []
    pt.on('data', (chunk: Buffer) => buffer.push(chunk))

    restoreTerminalModes(pt as unknown as NodeJS.WritableStream)

    expect(buffer).toHaveLength(0)
  })
})
