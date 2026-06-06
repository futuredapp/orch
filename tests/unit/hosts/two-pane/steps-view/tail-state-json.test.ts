// MIGRATED → tests-new/unit/hosts/two-pane/steps-view/tail-state-json.test.ts (parent U14) — demote-relocated (pure logic); kept skipped on disk (D2).
// Unit tests for `tailStateJson` against real fs in a tempdir.
//
// Per the plan we skip burst-coalescing tests — those are too flaky in CI.
// The contract this file pins:
//   1. `start()` fires `onChange` once on mount (leading-edge fire).
//   2. A subsequent `writeFile` triggers a re-fire (poll fallback handles
//      the case where `fs.watch` mis-reports on macOS).
//   3. `stop()` is idempotent.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import { tailStateJson } from '../../../../../src/hosts/two-pane/steps-view/index.ts'
import { path as toPath } from '../../../../../src/services/types.ts'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp('/tmp/orch-stepsview-test-')
})

afterEach(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe.skip('tailStateJson', () => {
  it('fires onChange exactly once when start() is called against an existing file (leading-edge)', async () => {
    const filePath = `${tmpDir}/state.json`
    await fs.writeFile(filePath, '{"hello":1}')
    let calls = 0
    const handle = tailStateJson({
      filePath: toPath(filePath),
      onChange: () => {
        calls++
      },
    })

    await handle.start()

    expect(calls).toBe(1)
    await handle.stop()
  })

  it('re-fires onChange after a subsequent writeFile (poll fallback at 50ms catches it)', async () => {
    const filePath = `${tmpDir}/state.json`
    await fs.writeFile(filePath, '{"v":1}')
    let calls = 0
    const handle = tailStateJson({
      filePath: toPath(filePath),
      onChange: () => {
        calls++
      },
      pollIntervalMs: 50,
      trailingDebounceMs: 25,
      maxDebounceMs: 100,
    })
    await handle.start()
    expect(calls).toBe(1)

    await fs.writeFile(filePath, '{"v":2}')
    // Poll fallback at 50ms + trailing debounce at 25ms — generously wait 400ms.
    await wait(400)

    expect(calls).toBeGreaterThan(1)
    await handle.stop()
  })

  it('is idempotent on stop() — calling twice does not throw', async () => {
    const filePath = `${tmpDir}/state.json`
    await fs.writeFile(filePath, '{}')
    const handle = tailStateJson({
      filePath: toPath(filePath),
      onChange: () => {},
    })
    await handle.start()

    await handle.stop()
    await handle.stop()

    // Reaching this expect at all is the assertion — second stop() must not
    // throw, must not re-arm a watcher, must just no-op.
    expect(true).toBe(true)
  })
})
