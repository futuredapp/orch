// MIGRATED → tests-new/unit/cli/tail-lines.test.ts (parent U13) — relocated verbatim (import paths only); kept skipped on disk (D2).
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

const collect = (signal: AbortSignal, file: string): Promise<string[]> => {
  const out: string[] = []
  return (async () => {
    for await (const line of tailLines(path(file), signal)) out.push(line)
    return out
  })()
}

describe.skip('tailLines', () => {
  it('yields one line for each newline-terminated chunk written between ticks', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-tail-newline-')
    const file = join(tmpDir, 'events.ndjson')
    await fs.writeFile(file, '')

    const ctrl = new AbortController()
    const collector = collect(ctrl.signal, file)

    // Append three complete lines spread across two ticks so we exercise
    // the offset-advance + chunk-split loop.
    await fs.appendFile(file, 'one\ntwo\n')
    await new Promise((r) => setTimeout(r, 250))
    await fs.appendFile(file, 'three\n')
    await new Promise((r) => setTimeout(r, 250))
    ctrl.abort()

    const lines = await collector
    expect(lines).toEqual(['one', 'two', 'three'])
  })

  it('holds a partial line across ticks until a newline arrives', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-tail-partial-')
    const file = join(tmpDir, 'events.ndjson')
    await fs.writeFile(file, '')

    const ctrl = new AbortController()
    const collector = collect(ctrl.signal, file)

    // Write a partial fragment, wait for the loop to read it, then append
    // the rest. The completed line should be yielded exactly once.
    await fs.appendFile(file, 'half-')
    await new Promise((r) => setTimeout(r, 250))
    await fs.appendFile(file, 'and-half\n')
    await new Promise((r) => setTimeout(r, 250))
    ctrl.abort()

    const lines = await collector
    expect(lines).toEqual(['half-and-half'])
  })

  it('flushes a non-empty pending partial when abort fires before the trailing newline', async () => {
    tmpDir = await fs.mkdtemp('/tmp/orch-tail-flush-')
    const file = join(tmpDir, 'events.ndjson')
    await fs.writeFile(file, 'final fragment')

    const ctrl = new AbortController()
    const collector = collect(ctrl.signal, file)

    // Give the loop one tick to drain the file, then abort. The pending
    // partial line should appear in the yielded output.
    await new Promise((r) => setTimeout(r, 250))
    ctrl.abort()

    const lines = await collector
    expect(lines).toEqual(['final fragment'])
  })
})
