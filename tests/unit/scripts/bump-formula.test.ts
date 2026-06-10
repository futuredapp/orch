import { describe, expect, it } from 'bun:test'
import * as nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ASSETS,
  BumpFormulaError,
  bumpFormula,
  parseChecksums,
} from '../../../scripts/bump-formula.ts'

// A formula fixture whose block layout mirrors the staged Formula/orch.rb: one
// nested platform block per asset, each carrying its own url + all-zero seed
// sha256, plus a single top-level version.
const SEED_FORMULA = `class Orch < Formula
  desc "x"
  homepage "https://github.com/futuredapp/orch"
  version "0.0.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/futuredapp/orch/releases/download/v0.0.0/orch-darwin-arm64"
      sha256 "0000000000000000000000000000000000000000000000000000000000000000"
    end
    on_intel do
      url "https://github.com/futuredapp/orch/releases/download/v0.0.0/orch-darwin-x64"
      sha256 "0000000000000000000000000000000000000000000000000000000000000000"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/futuredapp/orch/releases/download/v0.0.0/orch-linux-x64"
      sha256 "0000000000000000000000000000000000000000000000000000000000000000"
    end
  end
end
`

/** Pull the sha256 that immediately follows a given asset's url line. */
function shaForAsset(formula: string, asset: string): string | undefined {
  const re = new RegExp(`url "[^"]*/${asset}"\\s*\\n\\s*sha256 "([0-9a-f]{64})"`)
  return formula.match(re)?.[1]
}

function sumsFile(entries: Record<string, string>): string {
  return `${Object.entries(entries)
    .map(([asset, sha]) => `${sha}  ${asset}`)
    .join('\n')}\n`
}

describe('parseChecksums', () => {
  it('parses plain `<sha>  <name>` lines into an asset→checksum map', () => {
    const sums = parseChecksums(`${'a'.repeat(64)}  orch-linux-x64\n`)

    expect(sums.get('orch-linux-x64')).toBe('a'.repeat(64))
  })

  it('tolerates the binary-marker `*name` form and blank lines', () => {
    const sums = parseChecksums(`\n${'b'.repeat(64)}  *orch-darwin-x64\n\n`)

    expect(sums.get('orch-darwin-x64')).toBe('b'.repeat(64))
  })
})

describe('bumpFormula', () => {
  it('rewrites all three urls, their matching sha256s, and the version', () => {
    const sums = parseChecksums(
      sumsFile({
        'orch-darwin-arm64': 'a'.repeat(64),
        'orch-darwin-x64': 'b'.repeat(64),
        'orch-linux-x64': 'c'.repeat(64),
      }),
    )

    const out = bumpFormula(SEED_FORMULA, '0.2.0', sums)

    expect(out).toContain('version "0.2.0"')
    for (const asset of ASSETS) {
      expect(out).toContain(
        `url "https://github.com/futuredapp/orch/releases/download/v0.2.0/${asset}"`,
      )
    }
    expect(shaForAsset(out, 'orch-darwin-arm64')).toBe('a'.repeat(64))
    expect(shaForAsset(out, 'orch-darwin-x64')).toBe('b'.repeat(64))
    expect(shaForAsset(out, 'orch-linux-x64')).toBe('c'.repeat(64))
  })

  it('is idempotent — re-bumping an already-bumped formula yields identical text', () => {
    const sums = parseChecksums(
      sumsFile({
        'orch-darwin-arm64': 'a'.repeat(64),
        'orch-darwin-x64': 'b'.repeat(64),
        'orch-linux-x64': 'c'.repeat(64),
      }),
    )

    const once = bumpFormula(SEED_FORMULA, '0.2.0', sums)
    const twice = bumpFormula(once, '0.2.0', sums)

    expect(twice).toBe(once)
  })

  it('replaces each sha256 only within its own block when checksums share a substring', () => {
    // Two checksums that differ only in the second hex digit — a naive global
    // replace would smear one across both blocks.
    const sums = parseChecksums(
      sumsFile({
        'orch-darwin-arm64': `a0${'0'.repeat(62)}`,
        'orch-darwin-x64': `a1${'0'.repeat(62)}`,
        'orch-linux-x64': 'f'.repeat(64),
      }),
    )

    const out = bumpFormula(SEED_FORMULA, '1.0.0', sums)

    expect(shaForAsset(out, 'orch-darwin-arm64')).toBe(`a0${'0'.repeat(62)}`)
    expect(shaForAsset(out, 'orch-darwin-x64')).toBe(`a1${'0'.repeat(62)}`)
    expect(shaForAsset(out, 'orch-linux-x64')).toBe('f'.repeat(64))
  })

  it('throws naming the missing platform when a checksum is absent', () => {
    const sums = parseChecksums(
      sumsFile({
        'orch-darwin-arm64': 'a'.repeat(64),
        'orch-darwin-x64': 'b'.repeat(64),
        // orch-linux-x64 deliberately omitted
      }),
    )

    expect(() => bumpFormula(SEED_FORMULA, '0.2.0', sums)).toThrow(
      /missing checksum for orch-linux-x64/,
    )
  })

  it('throws (and so the caller leaves the file untouched) when a platform block is absent', () => {
    const formulaMissingLinux = SEED_FORMULA.replace(/\n {2}on_linux do[\s\S]*?\n {2}end\n/, '\n')
    const sums = parseChecksums(
      sumsFile({
        'orch-darwin-arm64': 'a'.repeat(64),
        'orch-darwin-x64': 'b'.repeat(64),
        'orch-linux-x64': 'c'.repeat(64),
      }),
    )

    expect(() => bumpFormula(formulaMissingLinux, '0.2.0', sums)).toThrow(BumpFormulaError)
    expect(() => bumpFormula(formulaMissingLinux, '0.2.0', sums)).toThrow(/orch-linux-x64/)
  })
})

describe('the staged Formula/orch.rb (U12a ↔ U7 contract)', () => {
  it('matches bump-formula.ts anchors so a real bump succeeds', async () => {
    const repoRoot = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '../../..')
    const stagedFormula = nodePath.join(
      repoRoot,
      'dist-staging',
      'homebrew-orch',
      'Formula',
      'orch.rb',
    )
    const formula = await Bun.file(stagedFormula).text()
    const sums = parseChecksums(
      sumsFile({
        'orch-darwin-arm64': 'a'.repeat(64),
        'orch-darwin-x64': 'b'.repeat(64),
        'orch-linux-x64': 'c'.repeat(64),
      }),
    )

    const out = bumpFormula(formula, '9.9.9', sums)

    expect(out).toContain('version "9.9.9"')
    expect(shaForAsset(out, 'orch-darwin-arm64')).toBe('a'.repeat(64))
    expect(shaForAsset(out, 'orch-linux-x64')).toBe('c'.repeat(64))
  })
})
