// ---------------------------------------------------------------------------
// Emulated Codex fork (R11a).
//
// Codex has no headless `--fork-session`, so we emulate it: copy the checkpoint
// rollout JSONL to a fresh id'd file, rewrite the `session_meta` id, and resume
// THAT copy — leaving the original checkpoint untouched (R8). `codex exec resume
// <id>` locates a session by scanning `$CODEX_HOME/sessions/**` and matching the
// id, so the copy only needs to live under the sessions root with a rewritten
// `session_meta.payload.id`; the filename is cosmetic for lookup.
//
// Pinned to the rollout layout observed on Codex 0.135/0.136 (first line is a
// `{"type":"session_meta","payload":{"id":...,"cwd":...}}` record; the runtime
// already carries a native `forked_from_id` we mirror). A FORMAT SANITY CHECK
// gates the copy (R11a): if the first line isn't a session_meta carrying the
// expected id, or any fs step fails, we return a failure verdict and the caller
// degrades to resume-in-place (R7). FsService has no `copyFile`, so the copy is
// read+rewrite+write — which is exactly where the id rewrite happens.
// ---------------------------------------------------------------------------

import type { FsService } from '../../services/fs/index.ts'
import { type Path, path } from '../../services/types.ts'

export type ForkRolloutResult =
  | { readonly ok: true; readonly newSessionId: string; readonly path: Path }
  | { readonly ok: false; readonly reason: 'not-found' | 'sanity' | 'error' }

export interface ForkRolloutInputs {
  readonly fs: FsService
  /** `$CODEX_HOME/sessions` (or the `ORCH_CODEX_SESSIONS_ROOT` override). */
  readonly sessionsRoot: Path | undefined
  readonly checkpointSessionId: string
  /** Freshly minted id for the forked copy (collision-free, caller-supplied). */
  readonly newSessionId: string
  /** Epoch ms for the copy's filename + metadata timestamp (from `clock.now()`). */
  readonly now: number
}

interface SessionMetaLine {
  readonly type: string
  readonly payload?: Record<string, unknown>
}

/** UTC `YYYY-MM-DD` + `THH-mm-ss` halves of `now`, used for the date dir and the
 *  cosmetic filename timestamp. UTC keeps it deterministic under FakeClock. */
function timestampParts(now: number): { dateDir: string; fileStamp: string } {
  const d = new Date(now)
  const yyyy = d.getUTCFullYear().toString()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const min = String(d.getUTCMinutes()).padStart(2, '0')
  const ss = String(d.getUTCSeconds()).padStart(2, '0')
  return { dateDir: `${yyyy}/${mm}/${dd}`, fileStamp: `${yyyy}-${mm}-${dd}T${hh}-${min}-${ss}` }
}

/** Dirname of a relative rollout path (`2026/06/02/rollout-….jsonl` → `2026/06/02`). */
function dirOf(relative: string): string {
  const idx = relative.lastIndexOf('/')
  return idx === -1 ? '' : relative.slice(0, idx)
}

async function findRolloutPath(
  fs: FsService,
  sessionsRoot: Path,
  checkpointSessionId: string,
): Promise<Path | undefined> {
  // The id is embedded in the filename, so a single glob locates it regardless
  // of which day dir the checkpoint landed in.
  for await (const match of fs.glob(`**/rollout-*${checkpointSessionId}.jsonl`, {
    cwd: sessionsRoot,
  })) {
    return path(`${sessionsRoot}/${match}`)
  }
  return undefined
}

/** Rewrite the first `session_meta` line's id to `newSessionId` and record the
 *  parent as `forked_from_id` (mirroring Codex's own native fork metadata).
 *  Returns the rewritten line, or `undefined` when the line fails the sanity
 *  check (not a session_meta, or id mismatch). */
function rewriteSessionMeta(
  firstLine: string,
  checkpointSessionId: string,
  newSessionId: string,
): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(firstLine)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as SessionMetaLine
  if (record.type !== 'session_meta') return undefined
  const payload = record.payload
  if (typeof payload !== 'object' || payload === null) return undefined
  if (payload.id !== checkpointSessionId) return undefined

  const nextPayload = { ...payload, id: newSessionId, forked_from_id: checkpointSessionId }
  return JSON.stringify({ ...record, payload: nextPayload })
}

/**
 * Emulate a Codex fork by copying + rewriting the checkpoint rollout. Returns a
 * discriminated verdict; on `ok: false` the caller degrades to resume-in-place
 * (R7/R11a). Never throws.
 */
export async function forkCodexRollout(inputs: ForkRolloutInputs): Promise<ForkRolloutResult> {
  const { fs, sessionsRoot, checkpointSessionId, newSessionId, now } = inputs
  if (sessionsRoot === undefined) return { ok: false, reason: 'error' }

  try {
    const sourcePath = await findRolloutPath(fs, sessionsRoot, checkpointSessionId)
    if (sourcePath === undefined) return { ok: false, reason: 'not-found' }

    const raw = await fs.readFile(sourcePath)
    const newlineIdx = raw.indexOf('\n')
    const firstLine = newlineIdx === -1 ? raw : raw.slice(0, newlineIdx)
    const rest = newlineIdx === -1 ? '' : raw.slice(newlineIdx)

    const rewritten = rewriteSessionMeta(firstLine, checkpointSessionId, newSessionId)
    if (rewritten === undefined) return { ok: false, reason: 'sanity' }

    const { dateDir, fileStamp } = timestampParts(now)
    // Place the copy beside the source's day dir so it is found by the same scan;
    // fall back to the `now` day dir if the source path had no dir segment.
    const targetDir = dirOf(sourcePath.slice(sessionsRoot.length + 1)) || dateDir
    const targetPath = path(
      `${sessionsRoot}/${targetDir}/rollout-${fileStamp}-${newSessionId}.jsonl`,
    )

    await fs.mkdir(path(`${sessionsRoot}/${targetDir}`), { recursive: true })
    await fs.writeFile(targetPath, `${rewritten}${rest}`)

    return { ok: true, newSessionId, path: targetPath }
  } catch {
    return { ok: false, reason: 'error' }
  }
}
