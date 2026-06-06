// ---------------------------------------------------------------------------
// Baseline snapshot generator (D12) — the FROZEN record migration runs against.
// ---------------------------------------------------------------------------
//
// Walks `tests/**`, classifies every path, and for every `test` file records
// each `it()`/`test()`/`it.each` case with a stable identity (file, name, line,
// hash). The output (`baseline.json` + `baseline.md`) is committed once at the
// end of U1 and never regenerated against the mutating tree — all downstream
// migration accounting and the U14 reconciliation query THIS frozen artifact.
//
// It must NOT `import` test files (that would register/execute Bun tests —
// parent §5.3): it reads source text and parses the TypeScript AST instead.
//
// Run as a script to (re)write the artifact: `bun run tests-new/_migration/snapshot.ts`.

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as ts from 'typescript'

export type Classification = 'test' | 'type-test' | 'helper' | 'fixture' | 'setup' | 'asset'

export interface BaselineCase {
  readonly name: string
  readonly line: number
  readonly hash: string
}

export interface BaselineEntry {
  readonly path: string
  readonly classification: Classification
  /** Which rule decided the classification — keeps reconciliation auditable. */
  readonly rule: string
  /** Present only for `test` files. */
  readonly cases?: readonly BaselineCase[]
}

export interface Baseline {
  readonly schemaVersion: 1
  readonly generatedFrom: string
  readonly fileCount: number
  readonly caseCount: number
  readonly classificationCounts: Record<Classification, number>
  readonly files: readonly BaselineEntry[]
}

const ROOT = 'tests'

// --- classification ---------------------------------------------------------

function classify(relPath: string): { classification: Classification; rule: string } {
  if (relPath.endsWith('.test-d.ts')) return { classification: 'type-test', rule: 'ext:.test-d.ts' }
  if (relPath.endsWith('.test.ts') || relPath.endsWith('.test.tsx')) {
    return { classification: 'test', rule: 'ext:.test.ts(x)' }
  }
  if (relPath.startsWith('tests/helpers/'))
    return { classification: 'helper', rule: 'dir:tests/helpers' }
  if (relPath.startsWith('tests/fixtures/')) {
    return { classification: 'fixture', rule: 'dir:tests/fixtures' }
  }
  if (relPath.startsWith('tests/setup/'))
    return { classification: 'setup', rule: 'dir:tests/setup' }
  return { classification: 'asset', rule: 'default' }
}

// --- case extraction (TS AST, never import) ---------------------------------

function headIdentifier(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text
  if (ts.isPropertyAccessExpression(expr)) return headIdentifier(expr.expression)
  if (ts.isCallExpression(expr)) return headIdentifier(expr.expression)
  if (ts.isParenthesizedExpression(expr)) return headIdentifier(expr.expression)
  return undefined
}

function stringArgText(arg: ts.Expression): string | undefined {
  if (ts.isStringLiteralLike(arg)) return arg.text
  if (ts.isTemplateExpression(arg)) return arg.getText()
  return undefined
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function extractCases(source: string, fileName: string): readonly BaselineCase[] {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind)
  const cases: BaselineCase[] = []

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const head = headIdentifier(node.expression)
      const firstArg = node.arguments[0]
      const name = firstArg === undefined ? undefined : stringArgText(firstArg)
      if ((head === 'it' || head === 'test') && name !== undefined) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
        const normalized = node.getText(sf).replace(/\s+/g, ' ').trim()
        cases.push({ name, line, hash: fnv1a(normalized) })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return cases
}

// --- walk + assemble --------------------------------------------------------

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      out.push(...walk(full))
    } else {
      out.push(full)
    }
  }
  return out
}

function emptyCounts(): Record<Classification, number> {
  return { test: 0, 'type-test': 0, helper: 0, fixture: 0, setup: 0, asset: 0 }
}

export function generateBaseline(root: string = ROOT): Baseline {
  const paths = walk(root)
    .map((p) => p.split('\\').join('/'))
    .sort()
  const counts = emptyCounts()
  let caseCount = 0
  const files: BaselineEntry[] = paths.map((path) => {
    const { classification, rule } = classify(path)
    counts[classification] += 1
    if (classification === 'test') {
      const cases = extractCases(readFileSync(path, 'utf-8'), path)
      caseCount += cases.length
      return { path, classification, rule, cases }
    }
    return { path, classification, rule }
  })

  return {
    schemaVersion: 1,
    generatedFrom: root,
    fileCount: files.length,
    caseCount,
    classificationCounts: counts,
    files,
  }
}

// --- rendering --------------------------------------------------------------

export function renderJson(baseline: Baseline): string {
  return `${JSON.stringify(baseline, null, 2)}\n`
}

export function renderMarkdown(baseline: Baseline): string {
  const lines: string[] = []
  lines.push('# Migration baseline (FROZEN — D12)')
  lines.push('')
  lines.push('Snapshot of every `tests/**` path at the end of parent phase U1. Do NOT regenerate')
  lines.push('against the mutating tree — U4–U14 accounting queries this frozen artifact.')
  lines.push('')
  lines.push(`- Files: **${baseline.fileCount}**`)
  lines.push(`- Test cases: **${baseline.caseCount}**`)
  lines.push('')
  lines.push('| Classification | Files |')
  lines.push('|---|---|')
  for (const key of Object.keys(baseline.classificationCounts) as Classification[]) {
    lines.push(`| ${key} | ${baseline.classificationCounts[key]} |`)
  }
  lines.push('')
  lines.push('## Test files and cases')
  lines.push('')
  for (const entry of baseline.files) {
    if (entry.classification !== 'test') continue
    lines.push(`### ${entry.path} (${entry.cases?.length ?? 0} cases)`)
    for (const c of entry.cases ?? []) {
      lines.push(`- L${c.line} \`${c.hash}\` — ${c.name}`)
    }
    lines.push('')
  }
  return `${lines.join('\n')}\n`
}

if (import.meta.main) {
  const baseline = generateBaseline()
  writeFileSync(join('tests-new', '_migration', 'baseline.json'), renderJson(baseline))
  writeFileSync(join('tests-new', '_migration', 'baseline.md'), renderMarkdown(baseline))
  process.stdout.write(
    `baseline: ${baseline.fileCount} files, ${baseline.caseCount} cases written\n`,
  )
}
