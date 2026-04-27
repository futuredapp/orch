// ---------------------------------------------------------------------------
// FileSessionLogger — file-backed SessionLogger adapter.
// ---------------------------------------------------------------------------
//
// Writes under `<basePath>/<runId>/logs/`. Every append goes to two files:
// the category NDJSON (spawns / events / lifecycle / subprocesses / orch)
// and the timeline mirror. `timeline.ndjson` is the AI reader's primary
// entry point — it's a source-tagged, timestamp-sorted union of everything.
//
// Concurrency: one serial append chain per category. Keeps lines atomic at
// the category level; the timeline mirror writes after the category file,
// inside the same chain. Crash during a chain tail loses at most one line
// (NDJSON readers tolerate trailing partial). Same pattern as
// transcript-sidecar.ts:77-94.
//
// Path safety: `writeFile` and `rawSink` pass their rel paths through a
// sanitizer that rejects traversal, NUL, and absolute paths. The `path()`
// branded constructor catches `..`; we add the leading-slash and control
// char checks because those are legal for `path()` but illegal under
// `<runDir>/logs/`.

import { randomUUID } from 'node:crypto'
import type { StepName } from '../core/types.ts'
import type { Clock, FsService } from '../services/index.ts'
import type { Path } from '../services/types.ts'
import { path } from '../services/types.ts'
import type { RunId } from '../state/index.ts'
import type {
  JsonObject,
  LogCategory,
  RawSink,
  SessionLogger,
  StepSpan,
  StepSpanId,
} from './session-logger.ts'
import { stepSpanId as stepSpanIdFactory } from './session-logger.ts'

export interface CreateFileSessionLoggerDeps {
  readonly fs: FsService
  readonly clock: Clock
  readonly runId: RunId
  readonly basePath: Path
  readonly debug: boolean
}

// Sanitize a rel path under `<runDir>/logs/`. Same spirit as
// `transcript-sidecar.ts:sanitizeStepName`, but accepts nested dirs
// (agents/..., tmux/...) so we guard the full path.
function sanitizeRelPath(rel: string): string {
  if (rel.length === 0) throw new Error('SessionLogger: rel path must not be empty')
  if (rel.startsWith('/')) throw new Error(`SessionLogger: rel path must not be absolute: ${rel}`)
  if (rel.includes('\0')) throw new Error('SessionLogger: NUL byte is not allowed in a rel path')
  // biome-ignore lint/suspicious/noControlCharactersInRegex: guarding log paths
  if (/[\x00-\x1f]/.test(rel)) {
    throw new Error(`SessionLogger: control chars are not allowed in a rel path: ${rel}`)
  }
  for (const segment of rel.split('/')) {
    if (segment === '..' || segment === '.') {
      throw new Error(`SessionLogger: traversal segment in rel path: ${rel}`)
    }
  }
  return rel
}

const TIMELINE_FILE = 'timeline.ndjson'

export function createFileSessionLogger(deps: CreateFileSessionLoggerDeps): SessionLogger {
  const logsDir = path(`${deps.basePath}/${deps.runId}/logs`)
  let logsDirEnsured: Promise<void> | undefined
  const dirsEnsured = new Map<string, Promise<void>>()
  // Per-category serial append chain. Prevents interleaving of lines and
  // keeps the timeline mirror strictly after its category file.
  const chains = new Map<LogCategory | '__timeline__' | '__whole__', Promise<void>>()
  // Track every scheduled write so `close()` can await them.
  let pending: Promise<void> = Promise.resolve()

  const ensureLogsDir = (): Promise<void> => {
    if (logsDirEnsured === undefined) {
      logsDirEnsured = deps.fs.mkdir(logsDir, { recursive: true })
    }
    return logsDirEnsured
  }

  const ensureSubDir = (relPath: string): Promise<void> => {
    const lastSlash = relPath.lastIndexOf('/')
    if (lastSlash === -1) return ensureLogsDir()
    const subRel = relPath.slice(0, lastSlash)
    const cached = dirsEnsured.get(subRel)
    if (cached !== undefined) return cached
    const task = ensureLogsDir().then(() =>
      deps.fs.mkdir(path(`${logsDir}/${subRel}`), { recursive: true }),
    )
    dirsEnsured.set(subRel, task)
    return task
  }

  const enqueue = (
    key: LogCategory | '__timeline__' | '__whole__',
    task: () => Promise<void>,
  ): Promise<void> => {
    const prev = chains.get(key) ?? Promise.resolve()
    const next = prev.then(task)
    const swallowed = next.catch(() => {})
    chains.set(key, swallowed)
    pending = pending.then(() => swallowed)
    return next
  }

  const appendNdjson = async (
    category: LogCategory,
    record: JsonObject,
    stepName?: StepName,
    spanId?: StepSpanId,
  ): Promise<void> => {
    const ts = deps.clock.now()
    const base: Record<string, unknown> = { ts }
    if (stepName !== undefined) base.stepName = stepName
    if (spanId !== undefined) base.stepSpanId = spanId
    const tagged = { ...base, ...record }
    const categoryFile = path(`${logsDir}/${category}.ndjson`)
    const timelineFile = path(`${logsDir}/${TIMELINE_FILE}`)
    const categoryLine = `${JSON.stringify(tagged)}\n`
    const timelineLine = `${JSON.stringify({ ...tagged, source: category })}\n`

    const categoryWrite = enqueue(category, async () => {
      await ensureLogsDir()
      await deps.fs.appendFile(categoryFile, categoryLine)
    })
    const timelineWrite = enqueue('__timeline__', async () => {
      await ensureLogsDir()
      await deps.fs.appendFile(timelineFile, timelineLine)
    })

    await Promise.all([categoryWrite, timelineWrite])
  }

  const writeFile = async (relPath: string, body: string): Promise<void> => {
    const rel = sanitizeRelPath(relPath)
    const fullPath = path(`${logsDir}/${rel}`)
    await enqueue('__whole__', async () => {
      await ensureSubDir(rel)
      const tmp = path(`${fullPath}.${process.pid}-${randomUUID()}.tmp`)
      try {
        await deps.fs.writeFile(tmp, body)
        await deps.fs.rename(tmp, fullPath)
      } catch (err) {
        await deps.fs.remove(tmp).catch(() => {})
        throw err
      }
    })
  }

  const rawSink = (relPath: string): RawSink | null => {
    if (!deps.debug) return null
    const rel = sanitizeRelPath(relPath)
    const fullPath = path(`${logsDir}/${rel}`)
    // Per-sink chain keeps bytes ordered without interleaving across sinks.
    const sinkKey = `__sink__:${rel}` as unknown as LogCategory
    let closed = false

    return {
      async write(chunk: Uint8Array | string): Promise<void> {
        if (closed) throw new Error(`SessionLogger: rawSink for ${rel} is closed`)
        const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
        await enqueue(sinkKey, async () => {
          await ensureSubDir(rel)
          await deps.fs.appendFile(fullPath, text)
        })
      },
      async close(): Promise<void> {
        closed = true
        // Flush any pending writes for this sink.
        const current = chains.get(sinkKey) ?? Promise.resolve()
        await current
      },
    }
  }

  return {
    runId: deps.runId,
    debug: deps.debug,
    logsDir,
    async append(category: LogCategory, record: JsonObject): Promise<void> {
      await appendNdjson(category, record)
    },
    forStep(name: StepName): StepSpan {
      const id = stepSpanIdFactory(randomUUID())
      return {
        stepSpanId: id,
        stepName: name,
        async append(category: LogCategory, record: JsonObject): Promise<void> {
          await appendNdjson(category, record, name, id)
        },
      }
    },
    writeFile,
    rawSink,
    async close(): Promise<void> {
      // Drain every chain. `pending` accumulates every scheduled swallowed
      // promise; awaiting it reaches the tail of every category.
      await pending
    },
  }
}
