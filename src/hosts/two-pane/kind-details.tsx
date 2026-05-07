// ---------------------------------------------------------------------------
// <KindDetails> — read-only info panel for non-replayable step kinds.
// ---------------------------------------------------------------------------
//
// commit / worktree / ask steps don't have transcripts to replay. They have
// values (`StepEntry.value`) that fully describe what happened. The right-
// pane-controller renders this panel into window 1 instead of running the
// transcript replay path.
//
// Pure presentation — no I/O, no Ink hooks. Returns a string the caller can
// pipe straight into `tmux sendKeys`. Keeps the test layer simple (string-in,
// string-out) and avoids dragging an Ink mount onto a pane just to render
// three lines of text.

import type { StepRow } from './steps-view/index.ts'

export interface KindDetailsInput {
  readonly step: StepRow
}

export function renderKindDetails({ step }: KindDetailsInput): string {
  const header = `── ${step.name} ──\r\n`
  switch (step.kind) {
    case 'commit':
      return `${header}${formatCommit(step.value)}`
    case 'worktree':
      return `${header}${formatWorktree(step.value)}`
    case 'ask':
      return `${header}${formatAsk(step.value)}`
    default:
      return `${header}(no details for kind "${step.kind}")\r\n`
  }
}

function formatCommit(value: unknown): string {
  if (value === null) return '(no commit — working tree was clean)\r\n'
  if (typeof value === 'object' && value !== null && 'sha' in value) {
    const sha = String((value as { sha: unknown }).sha)
    return `commit sha: ${sha}\r\n`
  }
  return '(missing commit value)\r\n'
}

function formatWorktree(value: unknown): string {
  if (typeof value !== 'object' || value === null) return '(missing worktree value)\r\n'
  const v = value as Record<string, unknown>
  const lines: string[] = []
  if (typeof v.path === 'string') lines.push(`path:    ${v.path}`)
  if (typeof v.branch === 'string') lines.push(`branch:  ${v.branch}`)
  if (typeof v.fromRef === 'string') lines.push(`fromRef: ${v.fromRef}`)
  if (lines.length === 0) lines.push('(missing worktree fields)')
  return `${lines.join('\r\n')}\r\n`
}

function formatAsk(value: unknown): string {
  if (typeof value !== 'object' || value === null) return '(missing ask value)\r\n'
  const v = value as Record<string, unknown>
  const lines: string[] = []
  if (v.cancelled === true) {
    lines.push('cancelled')
    if (typeof v.fields === 'object' && v.fields !== null) {
      for (const [k, val] of Object.entries(v.fields)) {
        if (typeof val === 'string') lines.push(`  ${k}: ${val}`)
      }
    }
  } else {
    if (typeof v.button === 'string') lines.push(`button: ${v.button}`)
    for (const [k, val] of Object.entries(v)) {
      if (k === 'cancelled' || k === 'button') continue
      if (typeof val === 'string') lines.push(`  ${k}: ${val}`)
    }
  }
  if (lines.length === 0) lines.push('(missing ask fields)')
  return `${lines.join('\r\n')}\r\n`
}
