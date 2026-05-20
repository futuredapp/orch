import type { Clock } from '../../services/clock/index.ts'
import type { FsService } from '../../services/fs/index.ts'
import { type Path, path } from '../../services/types.ts'
import type { CaptureHandle, CaptureResult } from '../types.ts'

// Codex 0.130.0 on macOS creates the rollout file at spawn but does not write
// the first `session_meta` line until after its first model response — observed
// at ~9s on a real interactive run. A 5s window misses this on every real
// session, so the default sits comfortably above the observed lag. The capture
// promise is awaited AFTER `host.runInteractive` returns, so this timeout never
// extends a user-visible wait — it only bounds how long we keep polling for a
// file that may never receive its first line.
const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_INTERVAL_MS = 100
const ONE_DAY_MS = 86_400_000

export type { CaptureHandle, CaptureResult } from '../types.ts'

export interface CaptureCodexThreadIdInputs {
  readonly fs: FsService
  readonly clock: Clock
  readonly cwd: Path
  /**
   * Root directory containing `YYYY/MM/DD/rollout-*.jsonl` files.
   * Required — callers compose with `resolveCodexSessionsRoot` to derive the
   * default from `process.env.ORCH_CODEX_SESSIONS_ROOT` or `os.homedir()`.
   * Passing `undefined` short-circuits to `{ error: 'error' }`.
   */
  readonly sessionsRoot: Path | undefined
  readonly signal?: AbortSignal
  /** Total capture window. Defaults to 60_000ms. */
  readonly timeoutMs?: number
  /** Poll cadence. Defaults to 100ms. */
  readonly intervalMs?: number
}

interface SessionMeta {
  readonly id: string
  readonly cwd: string
  readonly originator?: string
}

export interface SessionsRootResolution {
  readonly envOverride: string | undefined
  readonly homedir: string
}

export function resolveCodexSessionsRoot(deps: SessionsRootResolution): Path | undefined {
  const override = deps.envOverride
  if (override !== undefined && override.length > 0) {
    return path(override)
  }
  if (deps.homedir.length === 0) return undefined
  return path(`${deps.homedir}/.codex/sessions`)
}

export function captureCodexThreadId(inputs: CaptureCodexThreadIdInputs): CaptureHandle {
  const { fs, clock, cwd, sessionsRoot, signal } = inputs
  const timeoutMs = inputs.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const intervalMs = inputs.intervalMs ?? DEFAULT_INTERVAL_MS

  if (sessionsRoot === undefined) {
    return {
      snapshotReady: Promise.resolve(),
      result: Promise.resolve({ error: 'error' }),
    }
  }

  let resolveSnapshotReady = (): void => {}
  const snapshotReady = new Promise<void>((res) => {
    resolveSnapshotReady = res
  })

  const result = pollForThreadId({
    fs,
    clock,
    cwd,
    sessionsRoot,
    ...(signal !== undefined ? { signal } : {}),
    timeoutMs,
    intervalMs,
    onSnapshotReady: () => resolveSnapshotReady(),
  })

  return { snapshotReady, result }
}

interface PollInputs {
  readonly fs: FsService
  readonly clock: Clock
  readonly cwd: Path
  readonly sessionsRoot: Path
  readonly signal?: AbortSignal
  readonly timeoutMs: number
  readonly intervalMs: number
  readonly onSnapshotReady: () => void
}

async function pollForThreadId(inputs: PollInputs): Promise<CaptureResult> {
  const { fs, clock, cwd, sessionsRoot, signal, timeoutMs, intervalMs, onSnapshotReady } = inputs

  // Per-directory bookkeeping. `snapshot` holds files present at start of the
  // capture window for a given date — they are never "new". `processed` holds
  // files we've successfully parsed AND classified (matched or cwd-mismatch);
  // we skip them on subsequent iterations. Files we read but can't parse yet
  // (empty content, malformed JSON, missing fields) live in neither set so the
  // next iteration retries them — slow filesystems can race readDir ahead of
  // the first session_meta line being durable.
  const snapshots = new Map<string, Set<string>>()
  const processed = new Map<string, Set<string>>()
  const matched: Array<{ sessionId: string }> = []

  let snapshotComplete = false
  try {
    const startKey = dirKeyFor(clock.now())
    const startDir = sessionsDir(sessionsRoot, startKey)
    const initialFiles = await safeReadDir(fs, startDir)
    snapshots.set(startKey, new Set(initialFiles))
    processed.set(startKey, new Set())

    snapshotComplete = true
    onSnapshotReady()

    const deadline = clock.now() + timeoutMs

    while (true) {
      if (signal?.aborted) return { error: 'empty' }

      const now = clock.now()
      const today = dirKeyFor(now)
      const tomorrow = dirKeyFor(now + ONE_DAY_MS)
      const keys = today === tomorrow ? [today] : [today, tomorrow]

      for (const key of keys) {
        const snap = getOrInitSet(snapshots, key)
        const seen = getOrInitSet(processed, key)
        const dir = sessionsDir(sessionsRoot, key)
        const current = await safeReadDir(fs, dir)

        for (const file of current) {
          if (snap.has(file)) continue
          if (seen.has(file)) continue
          const fullPath = path(`${dir}/${file}`)
          const meta = await tryReadSessionMeta(fs, fullPath)
          if (meta === undefined) continue
          seen.add(file)
          if (meta.cwd === cwd) {
            matched.push({ sessionId: meta.id })
          }
        }
      }

      if (matched.length >= 2) return { error: 'ambiguous' }
      if (matched.length === 1) {
        const [only] = matched
        if (only !== undefined) return only
      }

      if (clock.now() >= deadline) return { error: 'empty' }
      await clock.sleep(intervalMs)
    }
  } catch {
    if (!snapshotComplete) onSnapshotReady()
    return { error: 'error' }
  }
}

function getOrInitSet(map: Map<string, Set<string>>, key: string): Set<string> {
  const existing = map.get(key)
  if (existing !== undefined) return existing
  const created = new Set<string>()
  map.set(key, created)
  return created
}

// UTC YYYY/MM/DD — match the layout Codex uses for `~/.codex/sessions`.
function dirKeyFor(epochMs: number): string {
  const d = new Date(epochMs)
  const y = d.getUTCFullYear().toString()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${y}/${m}/${dd}`
}

function sessionsDir(root: Path, key: string): Path {
  return path(`${root}/${key}`)
}

async function safeReadDir(fs: FsService, p: Path): Promise<readonly Path[]> {
  try {
    return await fs.readDir(p)
  } catch (err: unknown) {
    if (err instanceof Error && /ENOENT/.test(err.message)) return []
    throw err
  }
}

async function tryReadSessionMeta(fs: FsService, p: Path): Promise<SessionMeta | undefined> {
  let raw: string
  try {
    raw = await fs.readFile(p)
  } catch {
    return undefined
  }
  if (raw.length === 0) return undefined
  const firstLine = raw.split('\n', 1)[0]
  if (firstLine === undefined || firstLine.length === 0) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(firstLine)
  } catch {
    return undefined
  }

  if (typeof parsed !== 'object' || parsed === null) return undefined
  const obj = parsed as Record<string, unknown>
  if (obj.type !== 'session_meta') return undefined
  const payload = obj.payload
  if (typeof payload !== 'object' || payload === null) return undefined
  const p2 = payload as Record<string, unknown>
  if (typeof p2.id !== 'string' || p2.id.length === 0) return undefined
  if (typeof p2.cwd !== 'string' || p2.cwd.length === 0) return undefined

  const meta: SessionMeta = {
    id: p2.id,
    cwd: p2.cwd,
    ...(typeof p2.originator === 'string' ? { originator: p2.originator } : {}),
  }
  return meta
}
