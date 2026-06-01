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

// Top-level ask keys that carry their own formatting, so the generic
// field-dumper must skip them when printing the remaining fields.
const ASK_META_KEYS: ReadonlySet<string> = new Set(['cancelled', 'button'])

// Append `  key: value` for every string-valued entry, skipping `skip` keys.
// Shared by both formatAsk branches; extracted to keep formatAsk under the
// rule-5 cognitive-complexity budget.
function pushStringFields(
  lines: string[],
  obj: Record<string, unknown>,
  skip?: ReadonlySet<string>,
): void {
  for (const [k, val] of Object.entries(obj)) {
    if (skip?.has(k) === true) continue
    if (typeof val === 'string') lines.push(`  ${k}: ${val}`)
  }
}

function formatAsk(value: unknown): string {
  if (typeof value !== 'object' || value === null) return '(missing ask value)\r\n'
  const v = value as Record<string, unknown>
  const lines: string[] = []
  if (v.cancelled === true) {
    lines.push('cancelled')
    if (typeof v.fields === 'object' && v.fields !== null) {
      pushStringFields(lines, v.fields as Record<string, unknown>)
    }
  } else {
    if (typeof v.button === 'string') lines.push(`button: ${v.button}`)
    pushStringFields(lines, v, ASK_META_KEYS)
  }
  if (lines.length === 0) lines.push('(missing ask fields)')
  return `${lines.join('\r\n')}\r\n`
}
