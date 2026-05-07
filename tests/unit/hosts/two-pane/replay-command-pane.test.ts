import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolveCommandPaneSource } from '../../../../src/hosts/two-pane/replay-command-pane.ts'
import { path as toPath } from '../../../../src/services/types.ts'

// `resolveCommandPaneSource` returns where the right-pane-controller should
// `cat` from for a `command:` step's replay. When the pane log captured by
// `--debug`'s `pipe-pane` exists and is non-empty, the resolver returns
// `{ kind: 'file', path }` so the controller can `cat <existing>` directly
// (byte-fidelity preserved, no copy). When missing or empty, the resolver
// falls back to `{ kind: 'inline', text }` — the controller writes that
// placeholder to `<stateDir>/.replay/<step>.txt` and `cat`s that.

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp('/tmp/orch-rpc-test-')
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('resolveCommandPaneSource', () => {
  it('returns the captured pane log path when the file exists and has bytes', async () => {
    const ansiBody = '\x1b[31mred\x1b[0m\r\nplain\r\n'
    const logPath = toPath(`${tempDir}/pane.log`)
    await writeFile(logPath, ansiBody, 'utf8')

    const source = await resolveCommandPaneSource({
      stepName: 'command:lint',
      paneLogPath: logPath,
    })

    expect(source.kind).toBe('file')
    if (source.kind !== 'file') throw new Error('expected file source')
    expect(source.path).toBe(logPath)
  })

  it('returns the inline placeholder when paneLogPath is undefined', async () => {
    const source = await resolveCommandPaneSource({
      stepName: 'command:silent',
      paneLogPath: undefined,
    })

    expect(source.kind).toBe('inline')
    if (source.kind !== 'inline') throw new Error('expected inline source')
    expect(source.text).toContain('(no captured output')
    expect(source.text).toContain('command:silent')
  })

  it('returns the inline placeholder when the pane log file is empty', async () => {
    const emptyLog = toPath(`${tempDir}/empty.log`)
    await writeFile(emptyLog, '', 'utf8')

    const source = await resolveCommandPaneSource({
      stepName: 'command:also-silent',
      paneLogPath: emptyLog,
    })

    expect(source.kind).toBe('inline')
    if (source.kind !== 'inline') throw new Error('expected inline source')
    expect(source.text).toContain('(no captured output')
  })

  it('returns the inline placeholder when the pane log file is missing on disk', async () => {
    const missing = toPath(`${tempDir}/does-not-exist.log`)

    const source = await resolveCommandPaneSource({
      stepName: 'command:absent',
      paneLogPath: missing,
    })

    expect(source.kind).toBe('inline')
    if (source.kind !== 'inline') throw new Error('expected inline source')
    expect(source.text).toContain('(no captured output')
  })
})
