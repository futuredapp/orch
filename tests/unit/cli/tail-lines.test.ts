// Unit tests for `tailLines` (PR B — `--follow`'s inline tail loop).
//
// `tailLines` is the ~20-line helper inside `src/cli/commands/logs.ts` that
// the plan deliberately keeps out of the FsService port — orch writes the
// transcript file append-only and never rotates it, so a monotonically-
// increasing offset is enough. We exercise it against a real tmpdir using
// node's fs primitives so the test runs in any environment without
// scripted-content fakes.

import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { tailLines } from '../../../src/cli/commands/tail-lines.ts'
import { path } from '../../../src/services/types.ts'

let tmpDir: string

afterEach(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

const collectInto = (signal: AbortSignal, file: string, out: string[]): Promise<string[]> =>
  (async () => {
    for await (const line of tailLines(path(file), signal)) out.push(line)
    return out
  })()

/** Poll `cond` every 10 ms until true; throw after `timeoutMs`. */
const waitUntil = async (cond: () => boolean, timeoutMs = 5000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitUntil: condition not met in time')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('tailLines', () => {
  it('yields one line for each newline-terminated chunk written between ticks', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-tail-newline-')
    const file = join(tmpDir, 'events.ndjson')
    await fs.writeFile(file, '')
    const out: string[] = []
    const ctrl = new AbortController()
    const collector = collectInto(ctrl.signal, file, out)

    // Append complete lines, polling for each batch to be observed before
    // the next write, so we exercise the offset-advance + chunk-split loop
    // and only abort once all three lines have actually been read.
    await fs.appendFile(file, 'one\ntwo\n')
    await waitUntil(() => out.length >= 2)
    await fs.appendFile(file, 'three\n')
    await waitUntil(() => out.length >= 3)
    ctrl.abort()

    const lines = await collector
    expect(lines).toEqual(['one', 'two', 'three'])
  })

  it('holds a partial line across ticks until a newline arrives', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-tail-partial-')
    const file = join(tmpDir, 'events.ndjson')
    await fs.writeFile(file, '')
    const out: string[] = []
    const ctrl = new AbortController()
    const collector = collectInto(ctrl.signal, file, out)

    // Write a partial fragment, then the rest. The completed line should be
    // yielded exactly once once the newline arrives.
    await fs.appendFile(file, 'half-')
    // Best-effort pacing only: nudges the generator into reading the fragment
    // on its own tick so the split-read (partial-then-complete) path is the
    // likely one. The test passes either way — `waitUntil` below is the
    // correctness synchronization, not this sleep.
    await new Promise((r) => setTimeout(r, 250))
    await fs.appendFile(file, 'and-half\n')
    await waitUntil(() => out.includes('half-and-half'))
    ctrl.abort()

    const lines = await collector
    expect(lines).toEqual(['half-and-half'])
  })

  it('flushes a non-empty pending partial when abort fires before the trailing newline', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-tail-flush-')
    const file = join(tmpDir, 'events.ndjson')
    // Seed a terminated line plus an unterminated fragment. The sentinel line
    // gives the read loop an observable signal: once it is yielded, the loop
    // has consumed the file through the trailing fragment, so aborting now
    // exercises the pending-partial flush deterministically.
    await fs.writeFile(file, 'sentinel\nfinal fragment')
    const out: string[] = []
    const ctrl = new AbortController()
    const collector = collectInto(ctrl.signal, file, out)

    // Wait until the read loop has consumed the file through the fragment,
    // then abort. The pending partial line should appear in the output.
    await waitUntil(() => out.includes('sentinel'))
    ctrl.abort()

    const lines = await collector
    expect(lines).toEqual(['sentinel', 'final fragment'])
  })
})
