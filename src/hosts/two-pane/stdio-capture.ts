// ---------------------------------------------------------------------------
// stdio-capture — keep workflow-body output off tmux's foreground TTY.
// ---------------------------------------------------------------------------
//
// Under two-pane auto-attach, tmux owns the terminal while the orch parent
// keeps executing the workflow in-process. Workflow-body console.log calls
// therefore write to the same TTY tmux is drawing on, but outside tmux's
// repaint model. Capture those writes into the run logs instead.

import { format } from 'node:util'
import type { RawSink } from '../../observability/index.ts'

export interface StdioCapture {
  /** Restores globals and flushes captured bytes. Idempotent. */
  restore(): Promise<void>
}

export interface InstallStdioCaptureDeps {
  readonly target: RawSink
  readonly console?: Console
  readonly stdout?: NodeJS.WriteStream
}

type ConsoleMethod = (...args: readonly unknown[]) => void

export function installStdioCapture(deps: InstallStdioCaptureDeps): StdioCapture {
  const target = deps.target
  const consoleRef = deps.console ?? console
  const stdout = deps.stdout ?? process.stdout

  const originalLog = consoleRef.log
  const originalInfo = consoleRef.info
  const originalDebug = consoleRef.debug
  const originalWarn = consoleRef.warn
  const originalError = consoleRef.error
  const originalStdoutWrite = stdout.write

  let restored = false
  let pending: Promise<void> = Promise.resolve()

  const enqueue = (source: 'stdout' | 'stderr', body: string): void => {
    pending = pending
      .then(() => target.write(prefixLines(source, body)))
      .catch(() => {
        /* Capture must never break workflow execution. */
      })
  }

  const captureConsole =
    (source: 'stdout' | 'stderr'): ConsoleMethod =>
    (...args: readonly unknown[]): void => {
      enqueue(source, `${format(...args)}\n`)
    }

  consoleRef.log = captureConsole('stdout')
  consoleRef.info = captureConsole('stdout')
  consoleRef.debug = captureConsole('stdout')
  consoleRef.warn = captureConsole('stderr')
  consoleRef.error = captureConsole('stderr')

  stdout.write = ((chunk: unknown, encodingOrCb?: unknown, cb?: unknown): boolean => {
    const done =
      typeof encodingOrCb === 'function' ? encodingOrCb : typeof cb === 'function' ? cb : undefined
    enqueue('stdout', stringifyChunk(chunk))
    if (done !== undefined) queueMicrotask(() => done())
    return true
  }) as typeof stdout.write

  return {
    async restore(): Promise<void> {
      if (restored) return
      restored = true
      consoleRef.log = originalLog
      consoleRef.info = originalInfo
      consoleRef.debug = originalDebug
      consoleRef.warn = originalWarn
      consoleRef.error = originalError
      stdout.write = originalStdoutWrite
      await pending
      await target.close().catch(() => {})
    },
  }
}

function stringifyChunk(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk
  if (chunk instanceof Uint8Array) return new TextDecoder().decode(chunk)
  return String(chunk)
}

function prefixLines(source: 'stdout' | 'stderr', body: string): string {
  if (body.length === 0) return `[${source}] `
  const trailingNewline = body.endsWith('\n')
  const withoutTrailing = trailingNewline ? body.slice(0, -1) : body
  const prefixed = withoutTrailing
    .split('\n')
    .map((line) => `[${source}] ${line}`)
    .join('\n')
  return trailingNewline ? `${prefixed}\n` : prefixed
}
