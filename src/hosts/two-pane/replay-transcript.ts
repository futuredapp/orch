// ---------------------------------------------------------------------------
// replay-transcript — pure renderer for a step's NDJSON sidecar.
// ---------------------------------------------------------------------------
//
// Reads an `events.ndjson` sidecar from disk, runs every event through the
// caller-supplied `toTranscriptLines` renderer (or a JSON fallback), and
// returns the rendered bytes as a UTF-8 string. The right-pane controller
// then writes that string to a file under `<stateDir>/.replay/<step>.txt`
// and respawns the right pane with `cat <file>` so the bytes land in the
// pane's stdout (sidestepping pty-echo doubling that affects sendKeys).
//
// Naive load — see TODO comment below. A 100MB transcript will read into
// memory all at once. v2 owes us memory virtualization; the bun smoke test
// in Phase 4 caps acceptable resident-set growth.

import { readFile } from 'node:fs/promises'
import type { RunnerEvent, TranscriptLine } from '../../runners/index.ts'
import type { Path } from '../../services/types.ts'
import { renderTranscriptLine } from '../plain/render-line.ts'

export type TranscriptRenderer = (event: RunnerEvent) => readonly TranscriptLine[]

export interface RenderTranscriptOptions {
  /** Absolute path to the step's `events.ndjson`. */
  readonly transcriptPath: Path
  /**
   * Per-runner formatter. Phase 2 ships without a registry — the caller
   * passes the workflow's primary runner. Default is the JSON fallback that
   * renders each event as `[<kind>:<type>] <json-payload>`.
   */
  readonly toTranscriptLines?: TranscriptRenderer
  /**
   * Header line written before the replay starts. Defaults to
   * `── replay <stepName> ──` when omitted.
   */
  readonly header?: string
  /** Step name — used for transcript line prefixes. */
  readonly stepName: string
}

export async function renderTranscriptToString(opts: RenderTranscriptOptions): Promise<string> {
  // TODO(transcript-replay-memory): naive whole-file read. A 100MB transcript
  // will consume ~10× resident bytes through the JSON.parse+render path. Phase
  // 4's smoke test caps acceptable growth at 12×; revisit when a real
  // workflow trips it. Tracked at the load site so the hot path is obvious.
  const raw = await readFile(opts.transcriptPath, 'utf8')
  const renderer = opts.toTranscriptLines ?? defaultRenderer
  const header = opts.header ?? `── replay ${opts.stepName} ──`
  const out: string[] = [`${header}\r\n`]

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    let event: RunnerEvent
    try {
      event = JSON.parse(line) as RunnerEvent
    } catch {
      // Skip malformed lines silently — same posture as tail-ndjson.
      continue
    }
    const rendered = renderer(event)
    if (rendered.length === 0) continue
    const prefix = `[${opts.stepName}] `
    for (const tl of rendered) {
      const lines = renderTranscriptLine(tl, {
        color: true,
        prefix: tl.kind === 'line' ? prefix : '',
      })
      for (const r of lines) out.push(`${r}\r\n`)
    }
  }

  if (out.length === 1) out.push('(no events)\r\n')

  return out.join('')
}

const defaultRenderer: TranscriptRenderer = (event) => {
  const label = event.kind === 'terminal' ? `terminal:${event.type}` : `info:${event.type}`
  const body =
    event.kind === 'terminal'
      ? event.type === 'error'
        ? event.message
        : JSON.stringify(event.data ?? null)
      : JSON.stringify(event.payload ?? {})
  return [{ kind: 'line', category: 'system', label, body }]
}
