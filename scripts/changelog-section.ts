#!/usr/bin/env bun
//
// changelog-section.ts — the release CHANGELOG gate (R13) and release-notes
// extractor in one. Used by .github/workflows/release.yml:
//
//   - changelog-gate job:  bun scripts/changelog-section.ts --version X.Y.Z
//   - publish job:         bun scripts/changelog-section.ts --version X.Y.Z --extract > notes.md
//
// The gate must reject a BARE/STUB heading, not merely confirm a heading
// exists: a `## [X.Y.Z] - 2026-XX-XX` placeholder date or an empty section body
// fails, so the Release never ships notes sliced from an unfinished entry.

import { parseArgs } from 'node:util'

export class ChangelogError extends Error {}

export interface Section {
  /** The matched heading line, e.g. `## [0.1.0] - 2026-06-09`. */
  readonly heading: string
  /** The body between this heading and the next `## ` heading (trimmed ends). */
  readonly body: string
}

/**
 * Find and validate the changelog section for `version`. Throws
 * `ChangelogError` if the heading is missing, its date is still an `XX`
 * placeholder, or the section body is empty. Accepts both `## [X.Y.Z] - DATE`
 * and `## X.Y.Z` heading forms.
 */
export function extractSection(changelog: string, version: string): Section {
  const lines = changelog.split('\n')
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const headingRe = new RegExp(`^## \\[?${escaped}\\]?(?:\\s|$)`)

  const start = lines.findIndex((l) => headingRe.test(l))
  if (start === -1) {
    throw new ChangelogError(
      `CHANGELOG.md has no entry for version ${version} ` +
        `(expected a "## [${version}] - <date>" heading)`,
    )
  }

  const heading = lines[start] as string
  if (/\bX{2,}\b/i.test(heading) || /-\s*[0-9]{0,3}X/i.test(heading)) {
    throw new ChangelogError(
      `CHANGELOG.md entry for ${version} still has a placeholder date: "${heading.trim()}" ` +
        '— finalise the date before tagging',
    )
  }

  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if ((lines[i] as string).startsWith('## ')) {
      end = i
      break
    }
  }

  const body = lines.slice(start + 1, end).join('\n').trim()
  if (body === '') {
    throw new ChangelogError(
      `CHANGELOG.md entry for ${version} has an empty body — the Release would ship empty notes`,
    )
  }

  return { heading, body }
}

function fail(message: string): never {
  console.error(`changelog-section: ${message}`)
  process.exit(1)
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      version: { type: 'string' },
      file: { type: 'string', default: 'CHANGELOG.md' },
      extract: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  })
  if (values.version === undefined) fail('missing required --version <x.y.z>')

  const file = Bun.file(values.file as string)
  if (!(await file.exists())) fail(`changelog not found at "${values.file}"`)

  let section: Section
  try {
    section = extractSection(await file.text(), values.version)
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err))
  }

  if (values.extract) {
    // Release notes = the heading + body for this version.
    process.stdout.write(`${section.heading}\n\n${section.body}\n`)
  } else {
    console.log(`changelog-section: ${values.version} entry is present and non-stub — ok`)
  }
}

if (import.meta.main) {
  await main()
}
