// Runner-internal transcript formatting helpers shared by claude/ and codex/. Not on the public barrel.
//
// The Claude and Codex transcript formatters flatten each runner's NDJSON into
// TranscriptLines. These string/number helpers and truncation limits are
// byte-identical across both, so they live here once. Anything that legitimately
// diverges (e.g. `numberField`, Codex's `readNumber`) stays local to its runner.
//
// All helpers are pure: no I/O, no module-level side effects, no shared mutable
// state.

// Truncation limits — mirrored across both runners so the two transcripts stay
// visually consistent.
export const MAX_BASH_COMMAND = 120
export const MAX_FILE_PATH = 60
export const MAX_GENERIC_INPUT = 80
export const MAX_TOOL_RESULT_LINE = 80
export const MAX_ERROR_TEXT = 200
export const MAX_ASSISTANT_TEXT = 4000

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max - 1)}…`
}

export function middleEllipsis(p: string, max: number): string {
  if (p.length <= max) return p
  const tail = p.slice(p.lastIndexOf('/') + 1)
  if (tail.length + 4 >= max) return `…/${tail.slice(-(max - 2))}`
  return `…/${tail}`
}

export function firstLine(s: string): string {
  const nl = s.indexOf('\n')
  return nl === -1 ? s : s.slice(0, nl)
}

export function firstNonEmptyLine(s: string): string {
  for (const line of s.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length > 0) return trimmed
  }
  return ''
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export function humanCount(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

export function readString(
  obj: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const v = obj[key]
  return typeof v === 'string' ? v : undefined
}

export function readObject(
  obj: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> | undefined {
  const v = obj[key]
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined
  return v as Readonly<Record<string, unknown>>
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}
