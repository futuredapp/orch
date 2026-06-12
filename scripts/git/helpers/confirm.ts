#!/usr/bin/env bun
//
// confirm.ts — the human gates. Two interactive prompts the operator answers
// before anything leaves the machine: a dirty-tree warning (list uncommitted
// changes, which are NOT part of the release, and ask whether to continue) and
// the release confirmation (previous→new version + the EXACT CHANGELOG notes to
// be published, with the raw commit list as a cross-check).

import type { Version } from './version.ts'

const RULE = '─'.repeat(56)

export interface ReleaseSummary {
  readonly previous: Version | null
  readonly next: Version
  /** Current package.json version (before any bump); undefined if unset. */
  readonly packageVersion: string | undefined
  /** Whether the script will write + commit the version into package.json. */
  readonly willBump: boolean
  /** The CHANGELOG heading + body the GitHub Release will publish verbatim. */
  readonly changelog: string
  /** One-line log of commits since the previous tag. */
  readonly commits: string
}

export function renderSummary(summary: ReleaseSummary): string {
  const previous = summary.previous?.tag ?? '(none)'
  return [
    '',
    'Release confirmation',
    RULE,
    `  Previous:  ${previous}`,
    `  New:       ${summary.next.tag}   ${packageNote(summary)}`,
    '',
    `CHANGELOG entry for ${summary.next.version} — published verbatim as the release notes:`,
    indent(summary.changelog),
    '',
    `Commits since ${previous}:`,
    indent(summary.commits === '' ? '(none)' : summary.commits),
    RULE,
  ].join('\n')
}

/**
 * List uncommitted changes and ask whether to continue. These changes are NOT
 * part of the release (the tag is cut from the pushed branch), so this is a
 * warning to confirm, not a hard failure. Returns true to continue.
 */
export function confirmDirtyTree(changes: string, autoYes: boolean): boolean {
  console.log('\nUncommitted changes — these will NOT be included in the release:')
  console.log(indent(changes))
  return askYesNo(
    'Continue with a dirty working tree? [y/N]',
    autoYes,
    'not a TTY — commit/stash, or re-run with --yes to release with a dirty tree',
  )
}

/** Print the summary and ask whether to proceed. Returns true to proceed. */
export function confirmRelease(summary: ReleaseSummary, autoYes: boolean): boolean {
  console.log(renderSummary(summary))
  return askYesNo(
    'Proceed? open PR → wait checks → merge → tag → release  [y/N]',
    autoYes,
    'not a TTY — re-run with --yes to release non-interactively',
  )
}

// — internal helpers —

/** The parenthetical after the new version: bump arrow, or a match check. */
function packageNote(summary: ReleaseSummary): string {
  if (summary.willBump) {
    return `(package.json ${summary.packageVersion ?? '(unset)'} → ${summary.next.version}, will commit)`
  }
  return '(matches package.json ✓)'
}

function indent(block: string): string {
  return block
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n')
}

/**
 * Ask a yes/no question. With `autoYes` it answers yes without prompting;
 * without a TTY (and without `autoYes`) it throws `nonTtyHint` rather than hang.
 */
function askYesNo(question: string, autoYes: boolean, nonTtyHint: string): boolean {
  if (autoYes) {
    console.log(`${question} y  (--yes)`)
    return true
  }
  if (!process.stdin.isTTY) {
    throw new Error(nonTtyHint)
  }
  const answer = prompt(question)
  return answer !== null && /^y(es)?$/i.test(answer.trim())
}
