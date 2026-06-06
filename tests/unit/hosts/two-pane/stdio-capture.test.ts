import { describe, expect, it } from 'bun:test'
import { Writable } from 'node:stream'
import { installStdioCapture } from '../../../../src/hosts/two-pane/stdio-capture.ts'
import type { RawSink } from '../../../../src/observability/index.ts'

function makeTarget(): RawSink & { text(): string; closeCount(): number } {
  const chunks: string[] = []
  let closes = 0
  return {
    async write(chunk: Uint8Array | string): Promise<void> {
      chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk))
    },
    async close(): Promise<void> {
      closes++
    },
    text(): string {
      return chunks.join('')
    },
    closeCount(): number {
      return closes
    },
  }
}

function makeConsole(): Console {
  return {
    log() {},
    info() {},
    debug() {},
    warn() {},
    error() {},
  } as unknown as Console
}

function makeStdout(): NodeJS.WriteStream & { text(): string } {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk))
      cb()
    },
  }) as unknown as NodeJS.WriteStream & { text(): string }
  stream.text = () => chunks.join('')
  return stream
}

describe('installStdioCapture', () => {
  it('captures console.log output with object formatting', async () => {
    const target = makeTarget()
    const consoleRef = makeConsole()
    const capture = installStdioCapture({ target, console: consoleRef, stdout: makeStdout() })

    consoleRef.log('returned:', { exitCode: 0 })
    await capture.restore()

    expect(target.text()).toContain('[stdout] returned: { exitCode: 0 }\n')
  })

  it('captures console.warn and console.error as stderr lines', async () => {
    const target = makeTarget()
    const consoleRef = makeConsole()
    const capture = installStdioCapture({ target, console: consoleRef, stdout: makeStdout() })

    consoleRef.warn('careful')
    consoleRef.error('failed')
    await capture.restore()

    expect(target.text()).toContain('[stderr] careful\n')
    expect(target.text()).toContain('[stderr] failed\n')
  })

  it('captures direct stdout.write calls without touching the original stream', async () => {
    const target = makeTarget()
    const consoleRef = makeConsole()
    const stdout = makeStdout()
    const capture = installStdioCapture({ target, console: consoleRef, stdout })

    stdout.write('raw write\n')
    await capture.restore()

    expect(stdout.text()).toBe('')
    expect(target.text()).toBe('[stdout] raw write\n')
  })

  it('restores console and stdout.write so later writes use the original stream', async () => {
    const target = makeTarget()
    const consoleRef = makeConsole()
    const stdout = makeStdout()
    const originalLog = consoleRef.log
    const originalWrite = stdout.write
    const capture = installStdioCapture({ target, console: consoleRef, stdout })

    await capture.restore()
    stdout.write('after restore\n')

    expect(consoleRef.log).toBe(originalLog)
    expect(stdout.write).toBe(originalWrite)
    expect(stdout.text()).toBe('after restore\n')
  })

  it('restore is idempotent and closes the target once', async () => {
    const target = makeTarget()
    const capture = installStdioCapture({
      target,
      console: makeConsole(),
      stdout: makeStdout(),
    })

    await capture.restore()
    await capture.restore()

    expect(target.closeCount()).toBe(1)
  })
})
