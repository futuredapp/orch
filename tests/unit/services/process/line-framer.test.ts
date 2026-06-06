// MIGRATED → tests-new/unit/services/process/line-framer.test.ts (parent U12) — relocated verbatim (import paths only); kept skipped on disk (D2).
import { describe, expect, it } from 'bun:test'
import { frameLines } from '../../../../src/services/process/line-framer.ts'

async function collect(iter: AsyncIterable<string>): Promise<string[]> {
  const result: string[] = []
  for await (const line of iter) {
    result.push(line)
  }
  return result
}

function encode(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

async function* bytes(...chunks: string[]): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) {
    yield encode(chunk)
  }
}

describe.skip('frameLines', () => {
  it('splits a single chunk into one yield per newline-delimited line', async () => {
    const lines = await collect(frameLines(bytes('hello\nworld\n')))

    expect(lines).toEqual(['hello', 'world'])
  })

  it('strips a single trailing carriage return from each line for CRLF tolerance', async () => {
    const lines = await collect(frameLines(bytes('hello\r\nworld\r\n')))

    expect(lines).toEqual(['hello', 'world'])
  })

  it('yields the trailing residual when EOF arrives with a non-empty buffer', async () => {
    const lines = await collect(frameLines(bytes('hello\nworld')))

    expect(lines).toEqual(['hello', 'world'])
  })

  it('completes silently when EOF arrives with an empty buffer', async () => {
    const lines = await collect(frameLines(bytes('hello\n')))

    expect(lines).toEqual(['hello'])
  })

  it('yields nothing for an empty input stream', async () => {
    const lines = await collect(frameLines(bytes()))

    expect(lines).toEqual([])
  })

  it('reassembles lines that are split across chunk boundaries', async () => {
    const lines = await collect(frameLines(bytes('hel', 'lo\nwor', 'ld\n')))

    expect(lines).toEqual(['hello', 'world'])
  })

  it('decodes multi-byte UTF-8 characters that span chunk boundaries', async () => {
    // '👋' is U+1F44B, encoded as 4 bytes: F0 9F 91 8B
    const full = encode('👋\n')
    const chunk1 = full.slice(0, 2) // F0 9F
    const chunk2 = full.slice(2) // 91 8B 0A

    async function* splitBytes(): AsyncGenerator<Uint8Array> {
      yield chunk1
      yield chunk2
    }

    const lines = await collect(frameLines(splitBytes()))

    expect(lines).toEqual(['👋'])
  })
})
