#!/usr/bin/env bun
//
// bump-formula.ts — rewrite the homebrew-orch tap formula for a new release.
//
// Usage:
//   bun scripts/bump-formula.ts --version 0.2.0 --dist dist
//   bun scripts/bump-formula.ts --version 0.2.0 --dist dist --formula Formula/orch.rb
//
// This is the edit half of R14. Per the "prefer scripts over complex git"
// convention, the script owns ONLY the deterministic file edit — no git. The
// release workflow's bump-formula job does the checkout/commit/push around it.
//
// It reads `<dist>/SHA256SUMS` (lines `<sha256>  orch-<os>-<arch>`, as produced
// by `shasum -a 256` / `sha256sum`) and rewrites, for each of the three
// platform blocks in the formula: the `url` (to point at the new version's
// asset) and the `sha256` (anchored to that block's asset-named url, so two
// blocks can never cross-contaminate even if their checksums share a
// substring), plus the single top-level `version`.
//
// All validation happens before any write: if a checksum or a platform block
// is missing, the script exits non-zero with a clear message and leaves the
// formula file untouched. Re-running on an already-bumped formula is
// idempotent — every field is rewritten to its canonical form.

import { parseArgs } from 'node:util'

// The release-asset naming convention (Decision 7 in the public-release plan).
// This list is the four-way contract shared with build-binary.ts, release.yml,
// and Formula/orch.rb — a drift here breaks the brew download.
export const ASSETS = ['orch-darwin-arm64', 'orch-darwin-x64', 'orch-linux-x64'] as const

const RELEASE_URL_BASE = 'https://github.com/futuredapp/orch/releases/download'

/** Raised by the pure transform; `main()` maps it to a non-zero exit. */
export class BumpFormulaError extends Error {}

/** Escape a literal string for safe inclusion in a RegExp. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Parse a SHA256SUMS file into asset → checksum. Accepts both the plain
 * (`<sha>  name`) and binary-marker (`<sha>  *name`) forms; the filename is the
 * last whitespace-delimited token with any leading `*` stripped.
 */
export function parseChecksums(text: string): Map<string, string> {
  const sums = new Map<string, string>()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const parts = line.split(/\s+/)
    const sha = parts[0]
    const name = parts[parts.length - 1]?.replace(/^\*/, '')
    if (sha === undefined || name === undefined) continue
    if (!/^[0-9a-f]{64}$/i.test(sha)) continue
    sums.set(name, sha.toLowerCase())
  }
  return sums
}

/** Rewrite one platform block's url + sha256. Returns the new formula text. */
function bumpPlatform(formula: string, asset: string, version: string, sha: string): string {
  const assetRe = escapeRegExp(asset)

  // Rewrite the url line to the canonical form for this version (robust to the
  // previous version string, and idempotent).
  const urlLine = new RegExp(`^([ \\t]*)url "[^"]*/${assetRe}"`, 'm')
  if (!urlLine.test(formula)) {
    throw new BumpFormulaError(`formula has no url block for ${asset}`)
  }
  let next = formula.replace(urlLine, `$1url "${RELEASE_URL_BASE}/v${version}/${asset}"`)

  // Replace the sha256 that immediately follows THIS block's url, anchored by
  // the asset name so blocks can't cross-contaminate.
  const urlPlusSha = new RegExp(`(url "[^"]*/${assetRe}"\\s*\\n[ \\t]*sha256 ")[0-9a-fA-F]{64}(")`)
  if (!urlPlusSha.test(next)) {
    throw new BumpFormulaError(`formula has no sha256 following the ${asset} url`)
  }
  next = next.replace(urlPlusSha, `$1${sha}$2`)
  return next
}

/**
 * Pure transform: given the formula text, target version, and the parsed
 * checksums, return the bumped formula text. Throws `BumpFormulaError` (without
 * touching any file) if a checksum or a platform block is missing, so callers
 * can leave the on-disk formula untouched on failure.
 */
export function bumpFormula(
  formula: string,
  version: string,
  sums: Map<string, string>,
): string {
  // Validate every platform up front so a partial set never produces a
  // half-bumped formula.
  for (const asset of ASSETS) {
    if (!sums.has(asset)) {
      throw new BumpFormulaError(`missing checksum for ${asset} in SHA256SUMS`)
    }
  }

  let next = formula
  for (const asset of ASSETS) {
    next = bumpPlatform(next, asset, version, sums.get(asset) as string)
  }

  const versionLine = /^([ \t]*version ")[^"]*(")/m
  if (!versionLine.test(next)) {
    throw new BumpFormulaError('formula has no top-level version field')
  }
  return next.replace(versionLine, `$1${version}$2`)
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      version: { type: 'string' },
      dist: { type: 'string' },
      formula: { type: 'string', default: 'Formula/orch.rb' },
    },
    strict: true,
    allowPositionals: false,
  })

  const version = values.version
  const dist = values.dist
  const formulaPath = values.formula as string
  if (version === undefined) fail('missing required --version <x.y.z>')
  if (dist === undefined) fail('missing required --dist <dir>')

  const sumsFile = Bun.file(`${dist}/SHA256SUMS`)
  if (!(await sumsFile.exists())) fail(`no SHA256SUMS in --dist directory "${dist}"`)
  const sums = parseChecksums(await sumsFile.text())

  const formulaFile = Bun.file(formulaPath)
  if (!(await formulaFile.exists())) fail(`formula not found at "${formulaPath}"`)
  const formula = await formulaFile.text()

  let bumped: string
  try {
    bumped = bumpFormula(formula, version, sums)
  } catch (err) {
    // On any validation failure the file is left untouched (nothing written).
    fail(err instanceof Error ? err.message : String(err))
  }

  await Bun.write(formulaPath, bumped)
  console.log(`Bumped ${formulaPath} to v${version} (${ASSETS.length} platforms)`)
}

function fail(message: string): never {
  console.error(`bump-formula: ${message}`)
  process.exit(1)
}

if (import.meta.main) {
  await main()
}
