#!/usr/bin/env bun
//
// version.ts — parse and normalise the release version. The CLI accepts both
// `vM.M.P` and `M.M.P`; everything downstream works with the canonical pair
// { version (bare, matches package.json + CHANGELOG), tag (the v-prefixed ref
// that triggers .github/workflows/release.yml) }.

export class VersionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VersionError'
  }
}

export interface Version {
  /** Bare semver, e.g. `0.1.3` — matches package.json + CHANGELOG headings. */
  readonly version: string
  /** Tag form, e.g. `v0.1.3` — pushed to trigger the release pipeline. */
  readonly tag: string
  readonly major: number
  readonly minor: number
  readonly patch: number
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/

/** Normalise `vM.M.P` or `M.M.P` into a canonical `Version`, or throw. */
export function parseVersion(input: string): Version {
  const bare = input.trim().replace(/^[vV]/, '')
  const match = SEMVER.exec(bare)
  if (match === null) {
    throw new VersionError(`"${input}" is not a valid version — expected vM.M.P or M.M.P`)
  }
  return {
    version: bare,
    tag: `v${bare}`,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

/** Order two versions: > 0 when `a` is newer, < 0 when older, 0 when equal. */
export function compareVersions(a: Version, b: Version): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
}

/** Highest valid `v*` semver in a tag list; non-semver tags are ignored. */
export function highestVersion(tags: readonly string[]): Version | null {
  let best: Version | null = null
  for (const tag of tags) {
    let parsed: Version
    try {
      parsed = parseVersion(tag)
    } catch {
      continue
    }
    if (best === null || compareVersions(parsed, best) > 0) best = parsed
  }
  return best
}
