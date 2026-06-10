#!/usr/bin/env bun
//
// check-action-pins.ts — assert every `uses:` in .github/workflows/*.yml is
// pinned to a full 40-char commit SHA with a trailing `# vX.Y.Z` comment
// (Decision 8 / R11a). SHA is the only immutable, unforgeable ref; a mutable
// `@v4` or `@main` tag is a supply-chain hole, so this makes pinning
// machine-checkable rather than a review aspiration — a stray mutable ref fails
// the build.
//
// Local first-party reusable actions (`uses: ./...`) and Docker refs
// (`uses: docker://...`) are exempt. Run via `bun run check:actions`.

import { readdirSync } from 'node:fs'

const WORKFLOWS_DIR = '.github/workflows'

// `uses: owner/repo@<ref>` with everything after `@` captured up to whitespace
// or a `#` comment. Sub-action paths (`owner/repo/path@ref`) are allowed.
const USES_RE = /^\s*-?\s*uses:\s*([^\s#]+)\s*(#.*)?$/
const PINNED_RE = /@[0-9a-f]{40}$/
const VERSION_COMMENT_RE = /#\s*v?\d+\.\d+/

interface Violation {
  readonly file: string
  readonly line: number
  readonly text: string
  readonly reason: string
}

function checkLine(file: string, lineNo: number, raw: string): Violation | undefined {
  const m = raw.match(USES_RE)
  if (m === null) return undefined
  const ref = m[1] as string
  const comment = m[2] ?? ''

  // Exempt local (`./`) and Docker (`docker://`) refs — they have no SHA to pin.
  if (ref.startsWith('./') || ref.startsWith('docker://')) return undefined

  const base = { file, line: lineNo, text: raw.trim() }
  if (!PINNED_RE.test(ref)) {
    return { ...base, reason: `not pinned to a 40-char commit SHA: "${ref}"` }
  }
  if (!VERSION_COMMENT_RE.test(comment)) {
    return { ...base, reason: 'missing trailing `# vX.Y.Z` version comment' }
  }
  return undefined
}

function workflowFiles(): string[] {
  let entries: string[]
  try {
    entries = readdirSync(WORKFLOWS_DIR)
  } catch {
    console.error(`check-action-pins: no ${WORKFLOWS_DIR} directory`)
    process.exit(1)
  }
  return entries
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => `${WORKFLOWS_DIR}/${f}`)
}

async function main(): Promise<void> {
  const violations: Violation[] = []
  let usesCount = 0

  for (const file of workflowFiles()) {
    const text = await Bun.file(file).text()
    text.split('\n').forEach((raw, i) => {
      if (USES_RE.test(raw)) usesCount++
      const v = checkLine(file, i + 1, raw)
      if (v !== undefined) violations.push(v)
    })
  }

  if (violations.length > 0) {
    console.error('check-action-pins: unpinned or under-documented actions found:\n')
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  ${v.reason}\n    ${v.text}`)
    }
    console.error(
      '\nPin every action to a full commit SHA with a `# vX.Y.Z` comment, e.g.\n' +
        '  uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3',
    )
    process.exit(1)
  }

  console.log(`check-action-pins: ${usesCount} action ref(s) pinned to commit SHAs — ok`)
}

await main()
