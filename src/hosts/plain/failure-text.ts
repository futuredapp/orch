// ---------------------------------------------------------------------------
// failure-text — plain-host renderer for Story 1.5 failure frames.
// ---------------------------------------------------------------------------
//
// Pure string producer. Plain host writes the output to stderr so `--format=
// text` consumers get the block alongside the regular `[orch] step:failed`
// line, and `--format=json` consumers can skip it entirely (the structured
// event already carries everything a JSON consumer cares about).
//
// Frame copy deliberately mirrors the two-pane failure pane and the Story 1.5
// plan: headline + error message + stack (when present) + resume/logs hints +
// downstream skip list. Any change in shape lands in both renderers at once
// to keep the DX identical across modes.

import type { FailureSummary } from '../../core/failure-summary.ts'

export function renderFailureText(summary: FailureSummary): string {
  const lines: string[] = []

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

  return `${lines.join('\n')}\n`
}
