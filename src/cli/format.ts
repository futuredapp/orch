import type { RunState } from '../state/index.ts'

// ---------------------------------------------------------------------------
// TTY-aware glyphs — Unicode when stdout is a TTY, ASCII fallback otherwise
// ---------------------------------------------------------------------------

export function glyphs(tty: boolean): Record<RunState['status'], string> {
  return tty
    ? { completed: '✓', failed: '✗', crashed: '✗', running: '●' }
    : { completed: '+', failed: 'x', crashed: 'x', running: '*' }
}

// ---------------------------------------------------------------------------
// Duration formatting
// ---------------------------------------------------------------------------

export function formatDuration(state: RunState): string {
  if (state.endedAt !== undefined && state.startedAt > 0) {
    return formatMs(state.endedAt - state.startedAt)
  }

  // Fallback for v2 state or runs without endedAt: use step timestamps
  const steps = Object.values(state.steps)
  if (steps.length === 0) return '\u2014' // em dash

  const earliest = Math.min(...steps.map((s) => s.startedAt))
  const latest = Math.max(...steps.map((s) => s.endedAt))
  return formatMs(latest - earliest)
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const secs = Math.round(ms / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const remSecs = secs % 60
  return `${mins}m${remSecs}s`
}
