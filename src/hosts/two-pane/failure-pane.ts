// ---------------------------------------------------------------------------
// failure-pane — two-pane host renderer for Story 1.5 failure frames.
// ---------------------------------------------------------------------------
//
// Produces the line array that gets paste-buffered into the right pane when a
// step fails. The shape deliberately mirrors `renderFailureText` in the plain
// host — same headline, same error, same stack, same hints — so switching
// modes does not change the copy the user reads. The two-pane variant emits
// the lines with explicit `\r\n` endings and an extra leading blank line so
// the frame visually separates from the failing step's transcript.
//
// The status loop on the left pane consumes the same `step:failed` lifecycle
// event and marks the step `✗ failed`; that path stays in status-loop.ts —
// this file only produces the right-pane narrative.

import type { FailureSummary } from '../../core/failure-summary.ts'

export function renderFailurePaneLines(summary: FailureSummary): readonly string[] {
  const lines: string[] = []

  lines.push('')
  lines.push(`✗ step "${summary.stepName}" failed`)
  lines.push(`  ${summary.errorMessage}`)

  if (summary.stackTrace.length > 0) {
    lines.push('')
    for (const frame of summary.stackTrace) {
      lines.push(frame)
    }
  }

  if (summary.downstream.length > 0) {
    lines.push('')
    lines.push(`skipped downstream: ${summary.downstream.join(', ')}`)
  }

  lines.push('')
  lines.push(`resume:  ${summary.resumeHint}`)
  lines.push(`logs:    ${summary.logsHint}`)

  return lines
}

/**
 * Single payload for `send-keys` — joined with `\r\n` so the pane advances
 * one line per logical frame row (matches the transcript pane's convention in
 * tmux-host's onRunnerEvent).
 */
export function renderFailurePanePayload(summary: FailureSummary): string {
  return `${renderFailurePaneLines(summary).join('\r\n')}\r\n`
}
